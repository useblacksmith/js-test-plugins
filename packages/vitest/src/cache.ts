import { createHash } from 'node:crypto'

import {
	restoreBundle as restore,
	saveBundle as save,
	type BundleFormat,
	type CacheKey,
	type RestoreOutcome,
	type SaveOutcome,
} from '../../shared/src/actions-cache.js'

export {
	ENV_CACHE_URL,
	TIMEOUT_MS,
	TwirpError,
	cacheMode,
	type CacheKey,
	type RestoreOutcome,
	type SaveOutcome,
} from '../../shared/src/actions-cache.js'

/**
 * Keeps the dependency record and tree anchor in the Actions cache from
 * inside the run, so a job needs no restore/save steps. Speaks the cache
 * service's twirp API at ACTIONS_RESULTS_URL; on a Blacksmith runner a plain
 * step can reach it with no token, elsewhere the variable is absent and
 * nothing happens. Every failure here is logged
 * once and never changes the run.
 */

/** Bundle format; bumped when its shape changes so old entries are missed, not misread. */
export const BUNDLE_VERSION = 'blacksmith-vitest-bundle-1'
/** Files under the cache dir that travel in the bundle. */
export const RECORD_FILE =
	/^(dependencies\.json|blacksmith-dependencies\.json|blacksmith-packages\.json|blacksmith(-units)?(\.[0-9a-f]{12})?(\.\d+of\d+)?\.json)$/

export const DEFAULT_CACHE_PREFIX = 'blacksmith-vitest'

/**
 * What the recorded inputs were resolved and run under. A `matrix.node` job
 * on another major, or a platform whose resolution differs (case-insensitive
 * fs, `.node` binaries), must not vouch for this one.
 */
export function runtimeId(): string {
	return `node${process.versions.node.split('.')[0]}-${process.platform}-${process.arch}`
}

export function cacheKey(input: {
	snapshotVersion: number
	runtime: string
	/** Vitest's root relative to the repository: each package of a monorepo keeps its own entries. */
	root: string
	/** The workflow file and job, '' outside Actions: jobs keep their own entries. */
	job: string
	projects: string[]
	shard: { index: number } | null
	head: string
}): CacheKey {
	const scope = [
		`v${input.snapshotVersion}`,
		input.runtime,
		input.root !== '' || input.job !== '' || input.projects.some(Boolean)
			? createHash('sha1')
					.update([input.job, input.root, ...input.projects].join('\n'))
					.digest('hex')
					.slice(0, 12)
			: 'all',
		// The shard's number without the count: a run on another count finds
		// every entry, and takes each test file's record from the one that has it.
		`shard${input.shard?.index ?? 0}`,
	].join('-')
	const prefix = `${DEFAULT_CACHE_PREFIX}-${scope}-`
	return { key: `${prefix}${input.head}`, prefix }
}

/**
 * Whether `name` travels in a bundle of the run that keeps `records`: the
 * record of another vitest stays behind, where a later save would otherwise
 * pair it with an anchor it does not belong to.
 */
function travels(name: string, records: string): boolean {
	if (!RECORD_FILE.test(name)) return false
	return !/^(blacksmith-)?dependencies\.json$/.test(name) || name === records
}

function format(records: string): BundleFormat {
	return {
		version: BUNDLE_VERSION,
		userAgent: '@useblacksmith/vitest',
		travels: (name) => travels(name, records),
	}
}

/** Fetches the newest bundle under `prefix` (exact `key` first) into `cacheDir`; `records` is the record file this vitest reads. */
export function restoreBundle(
	base: string,
	cacheDir: string,
	key: CacheKey,
	records: string,
): Promise<RestoreOutcome> {
	return restore(base, cacheDir, key, format(records))
}

/** Uploads the record and anchors under the exact `key`; an existing entry for that key is left alone. */
export function saveBundle(
	base: string,
	cacheDir: string,
	key: CacheKey,
	records: string,
): Promise<SaveOutcome> {
	return save(base, cacheDir, key, format(records))
}
