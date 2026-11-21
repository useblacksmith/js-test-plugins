import { createHash } from 'node:crypto'
import {
	isPackagePath,
	manifestShape,
	packageVersion,
} from '../../shared/src/packages.ts'
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import picomatch from 'picomatch'

import {
	ENV_CACHE_URL,
	cacheMode,
	restoreBundle,
	saveBundle,
	type BundleFormat,
	type CacheKey,
} from '../../shared/src/actions-cache.ts'
import {
	anchorTree,
	headSha,
	knownPaths,
	type Tree,
} from '../../shared/src/git.ts'
import {
	RECORDS_VERSION,
	loadRecords,
	readManifests,
	recordedPaths,
	ruleGlobs,
	storeRecords,
	type Records,
	type StoredRecords,
} from './core.ts'
import { dataDir, log, suffix, type Shard, type State } from './state.ts'

const USER_AGENT = '@useblacksmith/jest'
const BUNDLE_VERSION = 'blacksmith-jest-bundle-1'
const TRAVELS = /^(records|anchor|units)(\.\d+of\d+)?\.json$/

/** Files that shape every test without any of them reading it: a change runs everything. */
const ALWAYS = [
	'package.json',
	'tsconfig.json',
	'.swcrc',
	'.babelrc',
	'.babelrc.json',
	...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'json'].flatMap((extension) => [
		`jest.config.${extension}`,
		`babel.config.${extension}`,
	]),
]

export interface Anchor {
	tree: Tree
}

export function toRelative(repo: string, file: string): string {
	return path.relative(repo, file).split(path.sep).join('/')
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as T
	} catch {
		return null
	}
}

/** The workflow file running this job, when it lives in this repository. */
function workflowPath(): string | null {
	const ref = process.env.GITHUB_WORKFLOW_REF
	const repository = process.env.GITHUB_REPOSITORY
	if (!ref || !repository || !ref.startsWith(`${repository}/`)) return null
	const file = ref.slice(repository.length + 1).split('@')[0] ?? ''
	return file.startsWith('.github/workflows/') ? file : null
}

/** `ALWAYS` in the working directory and at the repository root, and the workflow file. */
export function alwaysPaths({ cwd, repo }: State): string[] {
	const prefix = toRelative(repo, cwd)
	const workflow = workflowPath()
	return [
		...new Set([
			...ALWAYS,
			...(prefix === '' ? [] : ALWAYS.map((file) => `${prefix}/${file}`)),
			...(workflow === null ? [] : [workflow]),
		]),
	]
}

/** Repository files the `dependencies` globs name: nothing reads them, so only the anchor sees them change. */
async function ruleFiles({ repo, options }: State): Promise<string[]> {
	const globs = ruleGlobs(options)
	if (globs.length === 0) return []
	const matches = picomatch(globs, { dot: true })
	return [...(await knownPaths(repo))].filter((file) => matches(file))
}

/** The current tree of everything a change to which matters: `recorded`, the always-rerun files and the rule files. */
/**
 * The tree the anchor compares: file content for repository files, the
 * installed version for packages, and for the package.json files of `ALWAYS`
 * everything but their dependency fields. No lockfile is in it: the packages
 * a test loaded say whether an install changed anything for it.
 */
export async function currentTree(
	ctx: State,
	recorded: Iterable<string>,
	read: ReadonlySet<string>,
): Promise<Tree> {
	const paths = [...recorded]
	const always = alwaysPaths(ctx)
	const tree = await anchorTree(ctx.repo, [
		...paths.filter((file) => !isPackagePath(file)),
		...always,
		...(await ruleFiles(ctx)),
	])
	for (const file of paths) {
		if (!isPackagePath(file)) continue
		const version = packageVersion(path.join(ctx.repo, file))
		if (version !== null) tree[file] = version
	}
	for (const file of always) {
		if (path.posix.basename(file) !== 'package.json' || !(file in tree)) continue
		// One a test read itself is compared in full: its dependency fields are that test's input.
		if (read.has(file)) continue
		const shape = manifestShape(path.join(ctx.repo, file))
		if (shape !== null) tree[file] = shape
	}
	return tree
}

export const recordsFile = (ctx: State, shard: Shard | null): string =>
	path.join(dataDir(ctx.cwd), `records${suffix(shard)}.json`)
export const anchorFile = (ctx: State, shard: Shard | null): string =>
	path.join(dataDir(ctx.cwd), `anchor${suffix(shard)}.json`)

export async function writeRecords(
	ctx: State,
	shard: Shard | null,
	records: Records,
): Promise<number> {
	const tree = await currentTree(ctx, recordedPaths(records), readManifests(records))
	mkdirSync(dataDir(ctx.cwd), { recursive: true })
	writeFileSync(recordsFile(ctx, shard), JSON.stringify(storeRecords(records)))
	writeFileSync(
		anchorFile(ctx, shard),
		JSON.stringify({ tree } satisfies Anchor),
	)
	return Object.keys(tree).length
}

function cacheKey(
	{ cwd, repo }: State,
	/** The shard's number, 0 for a run without `--shard`: a run on another count finds every entry. */
	index: number,
	head: string,
): CacheKey {
	const job = `${workflowPath() ?? ''}#${process.env.GITHUB_JOB ?? ''}`
	const scope = createHash('sha1')
		.update([job, path.relative(repo, cwd)].join('\n'))
		.digest('hex')
		.slice(0, 12)
	const runtime = `node${process.versions.node.split('.')[0]}-${process.platform}-${process.arch}`
	const prefix = `blacksmith-jest-v${RECORDS_VERSION}-${runtime}-${scope}-shard${index}-`
	return { key: `${prefix}${head}`, prefix }
}

const FORMAT: BundleFormat = {
	version: BUNDLE_VERSION,
	userAgent: USER_AGENT,
	travels: (name) => TRAVELS.test(name),
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

/** What `maxShards` is when the options leave it out. */
export const DEFAULT_MAX_SHARDS = 20
const RESTORES_AT_ONCE = 20

/** One restored cache entry: its record, the tree it was saved against, and where its function record is. */
export interface Entry {
	key: string
	records: Records
	anchor: Anchor
	units: string
}

async function pooled<T, R>(
	items: readonly T[],
	atOnce: number,
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = []
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(atOnce, items.length) }, async () => {
			while (next < items.length) {
				const at = next++
				results[at] = await work(items[at] as T)
			}
		}),
	)
	return results
}

/** The record of shard `index` among the files a bundle brought to `dir`: the data directory may have held those of other shards too. */
function entryIn(dir: string, index: number, key: string): Entry | null {
	const named = index === 0 ? /^records\.json$/ : new RegExp(`^records\\.${index}of\\d+\\.json$`)
	let found: Entry | null = null
	for (const name of readdirSync(dir)) {
		if (!named.test(name)) continue
		const records = loadRecords(
			readJson<StoredRecords | Records>(path.join(dir, name)),
		)
		const anchor = readJson<Anchor>(path.join(dir, name.replace(/^records/, 'anchor')))
		if (!records || !anchor?.tree) continue
		if (found !== null && found.records.at >= records.at) continue
		found = {
			key,
			records,
			anchor,
			units: path.join(dir, name.replace(/^records/, 'units')),
		}
	}
	return found
}

/**
 * Pulls the newest record of every shard from the Actions cache when the
 * data directory holds none: a test file another shard ran last has its
 * record there. One entry becomes the data directory's record; several are
 * returned, for the caller to take each test file from the one that ran it
 * last. Never fails the run.
 */
export async function restore(
	ctx: State,
	shard: Shard | null,
): Promise<Entry[] | null> {
	const base = process.env[ENV_CACHE_URL]
	if (!base || !cacheMode().readable) return null
	if (existsSync(recordsFile(ctx, shard))) return null
	const own = shard?.index ?? 0
	const maxShards = ctx.options.maxShards ?? DEFAULT_MAX_SHARDS
	let failure: string | null = null
	let head: string
	try {
		head = await headSha(ctx.repo)
	} catch (error) {
		log(`dependency cache not restored: ${message(error)}`)
		return null
	}
	const fetched = await pooled(
		Array.from({ length: Math.max(maxShards, own) + 1 }, (_, at) => at),
		RESTORES_AT_ONCE,
		async (index) => {
			const dir = mkdtempSync(path.join(tmpdir(), 'blacksmith-jest-entry-'))
			try {
				const outcome = await restoreBundle(
					base,
					dir,
					cacheKey(ctx, index, head),
					FORMAT,
				)
				const entry = outcome.restored ? entryIn(dir, index, outcome.key) : null
				if (entry) return { index, entry }
			} catch (error) {
				failure = message(error)
			}
			rmSync(dir, { recursive: true, force: true })
			return null
		},
	)
	// The shard's own entry first: of two records of a test file as late as each other, its own is used.
	const found = fetched
		.filter((entry) => entry !== null)
		.sort((a, b) => Number(b.index === own) - Number(a.index === own))
		.map(({ entry }) => entry)
	const [only] = found
	if (only === undefined) {
		log(
			failure === null
				? `no dependency cache: no entry under ${cacheKey(ctx, own, head).prefix}`
				: `dependency cache not restored: ${failure}`,
		)
		return null
	}
	for (const entry of found) log(`restored dependency cache ${entry.key}`)
	if (found.length > 1) return found
	mkdirSync(dataDir(ctx.cwd), { recursive: true })
	writeFileSync(recordsFile(ctx, shard), JSON.stringify(storeRecords(only.records)))
	writeFileSync(anchorFile(ctx, shard), JSON.stringify(only.anchor))
	if (existsSync(only.units)) {
		copyFileSync(
			only.units,
			path.join(dataDir(ctx.cwd), `units${suffix(shard)}.json`),
		)
	}
	return null
}

export async function save(ctx: State, shard: Shard | null): Promise<void> {
	const base = process.env[ENV_CACHE_URL]
	if (!base) return
	try {
		const key = cacheKey(ctx, shard?.index ?? 0, await headSha(ctx.repo))
		const outcome = await saveBundle(base, dataDir(ctx.cwd), key, FORMAT)
		log(
			outcome.saved
				? `saved dependency cache ${key.key} (${outcome.bytes} bytes)`
				: `dependency cache not saved: ${outcome.reason}`,
		)
	} catch (error) {
		log(`dependency cache not saved: ${message(error)}`)
	}
}
