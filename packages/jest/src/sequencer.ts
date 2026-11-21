import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { diffTrees } from '../../shared/src/git.ts'
import {
	RECORDS_VERSION,
	emptyRecords,
	readManifests,
	loadRecords,
	recordedPaths,
	storeRecords,
	type StoredRecords,
	select,
	type Affects,
	type Decision,
	type Records,
} from './core.ts'
import {
	DEFAULT_MAX_SHARDS,
	alwaysPaths,
	anchorFile,
	currentTree,
	readJson,
	recordsFile,
	restore,
	toRelative,
	type Anchor,
	type Entry,
} from './project.ts'
import { affecting, mergeUnits } from './narrow.ts'
import { recordGlobals } from './record.ts'
import { dataDir, log, resolveFromJest, state, type Pending } from './state.ts'

/**
 * The `testSequencer`: Jest hands it every test file it is about to run, and
 * runs the ones it returns. `shard` is Jest's own, over every test file, before
 * any is dropped; `sort` drops the files the
 * change does not affect and leaves the order to Jest's own sequencer.
 */
interface Test {
	path: string
	context?: {
		resolver?: { resolveModule?: (from: string, specifier: string) => string }
	}
}

interface SequencerClass {
	new (...args: unknown[]): {
		sort(tests: Test[]): Test[] | Promise<Test[]>
		shard(
			tests: Test[],
			options: { shardIndex: number; shardCount: number },
		): Test[] | Promise<Test[]>
	}
}

interface GlobalConfig {
	watch?: boolean
	watchAll?: boolean
	collectCoverage?: boolean
}

const require = createRequire(import.meta.url)
const loaded = require(
	resolveFromJest(process.cwd(), '@jest/test-sequencer'),
) as { default?: SequencerClass } & SequencerClass
const Base: SequencerClass = loaded.default ?? loaded

export default class BlacksmithSequencer extends Base {
	private readonly blacksmithConfig: GlobalConfig | undefined
	/** The test files of every shard: a shard saves the records of the others' test files too, whose modules theirs resolve. */
	private everyTest: Test[] | null = null

	// Jest 30 passes `{ contexts, globalConfig }`; Jest 29 passes nothing.
	constructor(...args: unknown[]) {
		super(...args)
		this.blacksmithConfig = (
			args[0] as { globalConfig?: GlobalConfig } | undefined
		)?.globalConfig
	}

	override shard(
		tests: Test[],
		options: { shardIndex: number; shardCount: number },
	): Test[] | Promise<Test[]> {
		const ctx = state()
		const maxShards = ctx.options.maxShards ?? DEFAULT_MAX_SHARDS
		if (options.shardCount > maxShards) {
			throw new Error(
				`@useblacksmith/jest: --shard=${options.shardIndex}/${options.shardCount} splits the run into more than maxShards (${maxShards}) shards; raise the maxShards option to at least ${options.shardCount}`,
			)
		}
		ctx.shard = { index: options.shardIndex, count: options.shardCount }
		this.everyTest = tests
		return super.shard(tests, options)
	}

	override async sort(tests: Test[]): Promise<Test[]> {
		const ctx = state()
		const config = this.blacksmithConfig
		const watching =
			config?.watch ||
			config?.watchAll ||
			process.argv.some((arg) => arg === '--watch' || arg === '--watchAll')
		if (watching) return super.sort(tests)
		let selected = tests
		const resolvers = new Set(
			(this.everyTest ?? tests).flatMap((test) => test.context?.resolver ?? []),
		)
		ctx.oneResolver = resolvers.size <= 1
		ctx.resolve = (from, specifier) => {
			for (const resolver of resolvers) {
				try {
					const file = resolver.resolveModule?.(from, specifier)
					if (file) return file
				} catch {}
			}
			return null
		}
		try {
			const pending = await affected(
				tests.map((test) => toRelative(ctx.repo, test.path)),
				ctx.coverage || config?.collectCoverage === true,
			)
			ctx.pending = pending
			describe(pending)
			selected = tests.filter(
				(test) =>
					pending.selection[toRelative(ctx.repo, test.path)]?.run !== false,
			)
		} catch (error) {
			ctx.pending = null
			log(
				`running every test file: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		// The config helper lets a run without test files pass, for the run this
		// leaves nothing of; a run Jest itself found no test file for still fails.
		const passes =
			ctx.passWithNoTests || process.argv.includes('--passWithNoTests')
		if (tests.length === 0 && !passes) process.exitCode = 1
		// What the config loaded so far, and from here to the first test file what `globalSetup` loads and reads.
		recordGlobals()
		return super.sort(selected)
	}
}

async function affected(owned: string[], coverage: boolean): Promise<Pending> {
	const ctx = state()
	const shard = ctx.shard
	const entries = await restore(ctx, shard)
	if (entries) {
		try {
			return await fromEntries(entries, owned, coverage)
		} finally {
			for (const entry of entries) rmSync(entry.dir, { recursive: true, force: true })
		}
	}
	const records = loadRecords(readJson<StoredRecords | Records>(recordsFile(ctx, shard)))
	const anchor = readJson<Anchor>(anchorFile(ctx, shard))
	const everything = (reason: string): Record<string, Decision> =>
		Object.fromEntries(owned.map((spec) => [spec, { run: true, reason }]))
	let changed: string[] = []
	let selection: Record<string, Decision>
	let affects: Affects | undefined
	if (records?.version !== RECORDS_VERSION || !anchor?.tree) {
		selection = everything('no record')
	} else {
		// The recorded paths too: one that did not exist has no entry in the anchor, and appears in the diff once it does.
		changed = diffTrees(
			anchor.tree,
			await currentTree(
				ctx,
				[...Object.keys(anchor.tree), ...recordedPaths(records)],
				readManifests(records),
			),
		)
		const always = new Set(alwaysPaths(ctx))
		const trigger = changed.find((file) => always.has(file))
		if (trigger !== undefined) selection = everything(`changed: ${trigger}`)
		else if (coverage) {
			// Coverage of a part of the test files would fail or pass thresholds for the wrong reason.
			log('coverage is on: running every test file')
			selection = everything('coverage')
		} else {
			// Projects may map one specifier to different files, and the function record keeps one target.
			if (ctx.narrow && ctx.oneResolver) {
				affects = affecting(ctx, shard, records, changed)
			}
			selection = select(records, owned, changed, ctx.options, affects)
		}
	}
	return { shard, owned, changed, selection, affects }
}

/**
 * The decision when the records come from several cache entries. Each test
 * file is taken from the entry that ran it last, and that entry decides for
 * it against its own anchor, as a run restoring it alone would. What is left
 * of them all becomes the stored record: every test file nothing changed
 * for, this shard's and the others'.
 */
async function fromEntries(
	entries: readonly Entry[],
	owned: string[],
	coverage: boolean,
): Promise<Pending> {
	const ctx = state()
	const shard = ctx.shard
	const from = new Map<string, { time: number; entry: Entry }>()
	for (const entry of entries) {
		for (const [spec, record] of Object.entries(entry.records.files)) {
			const time = record.at ?? 0
			const known = from.get(spec)
			if (known === undefined || time > known.time) from.set(spec, { time, entry })
		}
	}
	const merged = emptyRecords()
	const selection: Record<string, Decision> = Object.fromEntries(
		owned.map((spec) => [spec, { run: true, reason: 'no record' }]),
	)
	const mine = new Set(owned)
	const always = new Set(alwaysPaths(ctx))
	const changed = new Set<string>()
	const sources: Array<{ records: Records; units: string; specs: string[] }> = []
	if (coverage) log('coverage is on: running every test file')
	for (const entry of entries) {
		const { records, anchor } = entry
		const specs = [...from]
			.filter(([, taken]) => taken.entry === entry)
			.map(([spec]) => spec)
		if (specs.length === 0) continue
		// Whatever becomes of its test files: what every test file depends on is loaded once and not again while a cache of the transformed files is warm.
		merged.global = [...new Set([...merged.global, ...records.global])].sort()
		const differs = diffTrees(
			anchor.tree,
			await currentTree(
				ctx,
				[...Object.keys(anchor.tree), ...recordedPaths(records)],
				readManifests(records),
			),
		)
		for (const file of differs) changed.add(file)
		const trigger = differs.find((file) => always.has(file))
		if (trigger !== undefined) {
			for (const spec of specs) {
				if (mine.has(spec)) selection[spec] = { run: true, reason: `changed: ${trigger}` }
			}
			continue
		}
		// Projects may map one specifier to different files, and the function record keeps one target.
		const affects =
			ctx.narrow && ctx.oneResolver && !coverage
				? affecting(ctx, shard, records, differs, entry.units)
				: undefined
		const verdict = select(records, specs, differs, ctx.options, affects)
		const kept: string[] = []
		for (const spec of specs) {
			const decision = verdict[spec]
			const record = records.files[spec]
			if (!decision || !record) continue
			if (mine.has(spec)) {
				selection[spec] = coverage ? { run: true, reason: 'coverage' } : decision
			}
			if (decision.run && decision.reason.startsWith('changed')) continue
			merged.files[spec] = record
			kept.push(spec)
		}
		if (kept.length === 0) continue
		merged.at = Math.max(merged.at, records.at)
		sources.push({ records, units: entry.units, specs: kept })
	}
	mkdirSync(dataDir(ctx.cwd), { recursive: true })
	writeFileSync(recordsFile(ctx, shard), JSON.stringify(storeRecords(merged)))
	if (ctx.narrow) mergeUnits(ctx, shard, merged, sources)
	return { shard, owned, changed: [...changed], selection, settled: true }
}

function describe(pending: Pending): void {
	const entries = Object.entries(pending.selection)
	const run = entries.filter(([, decision]) => decision.run)
	const shard = pending.shard
		? ` in shard ${pending.shard.index}/${pending.shard.count}`
		: ''
	const changed =
		pending.changed.length > 0
			? `; changed: ${pending.changed.slice(0, 10).join(', ')}${pending.changed.length > 10 ? `, and ${pending.changed.length - 10} more` : ''}`
			: ''
	log(
		`${run.length} of ${entries.length} test file(s) affected${shard}${changed}`,
	)
	for (const [spec, decision] of run) {
		if (decision.run)
			process.stderr.write(`  run  ${spec}  (${decision.reason})\n`)
	}
}
