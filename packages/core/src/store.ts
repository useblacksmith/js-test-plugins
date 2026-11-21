import { createHash } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
	ENV_CACHE_URL,
	cacheMode,
	restoreBundle,
	saveBundle,
	type BundleFormat,
	type CacheKey,
} from './actions-cache.ts'
import { jobId, runtimeId, type Anchor } from './anchor.ts'
import { headSha } from './git.ts'
import {
	RECORDS_VERSION,
	loadRecords,
	storeRecords,
	type Records,
	type StoredRecords,
} from './record.ts'

/**
 * Where the record lives: three files in a directory of the runner's
 * choosing (the record, its anchor, and the function record when the runner
 * narrows), named after the shard and the part of the suite the run covers,
 * and the same files in the Actions cache between jobs.
 */
export interface Shard {
	index: number
	count: number
}

export const suffix = (shard: Shard | null): string =>
	shard ? `.${shard.index}of${shard.count}` : ''

/** What `maxShards` is when the options leave it out. */
export const DEFAULT_MAX_SHARDS = 20
const RESTORES_AT_ONCE = 20
const BUNDLE_VERSION = 'blacksmith-tests-bundle-1'

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as T
	} catch {
		return null
	}
}

/** Written whole or not at all: another process of the run may be reading it. */
export function writeJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	writeFileSync(tmp, JSON.stringify(value))
	renameSync(tmp, file)
}

export interface StoreOptions {
	/** `jest`, `mocha`, `vitest`: one runner's entries are not another's. */
	runner: string
	/** The data directory. */
	dir: string
	repo: string
	cwd: string
	/** What part of the suite the run covers, when not all of it (a set of projects): runs covering different parts keep separate records. */
	part?: string
	maxShards?: number
	log(message: string): void
}

/** One restored cache entry: its record, the tree it was saved against, and where its function record is. */
export interface Entry {
	key: string
	records: Records
	anchor: Anchor
	units: string
	/** The temporary directory the entry was restored to, for the caller to remove. */
	dir: string
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

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

/** Whether the anchor was written by this job on this runtime; one that does not say is taken as is. */
export function sameRun(anchor: Anchor): boolean {
	return (
		(anchor.runtime === undefined || anchor.runtime === runtimeId()) &&
		(anchor.job === undefined || anchor.job === jobId())
	)
}

export class Store {
	readonly #options: StoreOptions
	readonly #tag: string
	readonly #format: BundleFormat

	constructor(options: StoreOptions) {
		this.#options = options
		this.#tag = options.part
			? `.${createHash('sha1').update(options.part).digest('hex').slice(0, 12)}`
			: ''
		const travels = new RegExp(
			`^(records|anchor|units)${this.#tag.replace('.', '\\.')}(\\.\\d+of\\d+)?\\.json$`,
		)
		this.#format = {
			version: BUNDLE_VERSION,
			userAgent: `@useblacksmith/${options.runner}`,
			travels: (name) => travels.test(name),
		}
	}

	get dir(): string {
		return this.#options.dir
	}

	get maxShards(): number {
		return this.#options.maxShards ?? DEFAULT_MAX_SHARDS
	}

	#file(kind: string, shard: Shard | null): string {
		return path.join(this.dir, `${kind}${this.#tag}${suffix(shard)}.json`)
	}

	recordsFile(shard: Shard | null): string {
		return this.#file('records', shard)
	}

	anchorFile(shard: Shard | null): string {
		return this.#file('anchor', shard)
	}

	unitsFile(shard: Shard | null): string {
		return this.#file('units', shard)
	}

	readRecords(shard: Shard | null): Records | null {
		return loadRecords(readJson<StoredRecords>(this.recordsFile(shard)))
	}

	/** The anchor, when it is one a run of this job on this runtime wrote. */
	readAnchor(shard: Shard | null): Anchor | null {
		const anchor = readJson<Anchor>(this.anchorFile(shard))
		if (!anchor?.tree) return null
		if (sameRun(anchor)) return anchor
		const by = (job: string | undefined, runtime: string | undefined): string =>
			`${job || 'a run outside Actions'} on ${runtime ?? 'an unknown runtime'}`
		this.#options.log(
			`the dependency record was made by ${by(anchor.job, anchor.runtime)}, this is ${by(jobId(), runtimeId())}: it vouches for nothing here`,
		)
		return null
	}

	writeRecords(shard: Shard | null, records: Records): void {
		writeJson(this.recordsFile(shard), storeRecords(records))
	}

	writeAnchor(shard: Shard | null, anchor: Anchor): void {
		writeJson(this.anchorFile(shard), anchor)
	}

	#key(
		/** The shard's number, 0 for a run that is not split: a run on another count finds every entry. */
		index: number,
		head: string,
	): CacheKey {
		const { runner, repo, cwd, part } = this.#options
		const scope = createHash('sha1')
			.update([jobId(), path.relative(repo, cwd), ...(part ? [part] : [])].join('\n'))
			.digest('hex')
			.slice(0, 12)
		const prefix = `blacksmith-${runner}-v${RECORDS_VERSION}-${runtimeId()}-${scope}-shard${index}-`
		return { key: `${prefix}${head}`, prefix }
	}

	/** The record of shard `index` among the files a bundle brought to `dir`: the data directory may have held those of other shards too. */
	#entryIn(dir: string, index: number, key: string): Entry | null {
		const tag = this.#tag.replace('.', '\\.')
		const named = new RegExp(
			index === 0 ? `^records${tag}\\.json$` : `^records${tag}\\.${index}of\\d+\\.json$`,
		)
		let found: Entry | null = null
		for (const name of readdirSync(dir)) {
			if (!named.test(name)) continue
			const records = loadRecords(readJson<StoredRecords>(path.join(dir, name)))
			const anchor = readJson<Anchor>(path.join(dir, name.replace(/^records/, 'anchor')))
			if (!records || !anchor?.tree || !sameRun(anchor)) continue
			if (found !== null && found.records.at >= records.at) continue
			found = {
				key,
				records,
				anchor,
				units: path.join(dir, name.replace(/^records/, 'units')),
				dir,
			}
		}
		return found
	}

	/**
	 * Pulls the newest record of every shard from the Actions cache when the
	 * data directory holds none: a test file another shard ran last has its
	 * record there. The caller takes each test file from the entry that ran
	 * it last, and removes the entries' directories. Never fails the run.
	 */
	async restore(shard: Shard | null): Promise<Entry[]> {
		const { log, repo } = this.#options
		const base = process.env[ENV_CACHE_URL]
		if (!base) {
			if (process.env.TURBO_HASH) {
				log(
					`running under turbo, which hides ${ENV_CACHE_URL} in strict env mode; add it to passThroughEnv to use the dependency cache`,
				)
			}
			return []
		}
		// Both, or the record is what a selection put together from the
		// entries, each compared with its own anchor: the next one does again.
		if (existsSync(this.recordsFile(shard)) && existsSync(this.anchorFile(shard))) {
			return []
		}
		if (!cacheMode().readable) {
			log('no dependency cache: the Actions cache is not readable for this job')
			return []
		}
		const own = shard?.index ?? 0
		let failure: string | null = null
		let head: string
		try {
			head = await headSha(repo)
		} catch (error) {
			log(`dependency cache not restored: ${message(error)}`)
			return []
		}
		const fetched = await pooled(
			Array.from({ length: Math.max(this.maxShards, own) + 1 }, (_, at) => at),
			RESTORES_AT_ONCE,
			async (index) => {
				const dir = mkdtempSync(path.join(tmpdir(), 'blacksmith-entry-'))
				try {
					const outcome = await restoreBundle(base, dir, this.#key(index, head), this.#format)
					const entry = outcome.restored ? this.#entryIn(dir, index, outcome.key) : null
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
		if (found.length === 0) {
			log(
				failure === null
					? `no dependency cache: no entry under ${this.#key(own, head).prefix}`
					: `dependency cache not restored: ${failure}`,
			)
		}
		for (const entry of found) log(`restored dependency cache ${entry.key}`)
		return found
	}

	async save(shard: Shard | null): Promise<void> {
		const { log, repo } = this.#options
		const base = process.env[ENV_CACHE_URL]
		if (!base) return
		try {
			const key = this.#key(shard?.index ?? 0, await headSha(repo))
			const outcome = await saveBundle(base, this.dir, key, this.#format)
			log(
				outcome.saved
					? `saved dependency cache ${key.key} (${outcome.bytes} bytes)`
					: `dependency cache not saved: ${outcome.reason}`,
			)
		} catch (error) {
			log(`dependency cache not saved: ${message(error)}`)
		}
	}
}
