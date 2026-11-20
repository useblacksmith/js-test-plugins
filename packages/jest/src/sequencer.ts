import { createRequire } from 'node:module'

import { diffTrees } from '../../shared/src/git.ts'
import { shardFor } from '../../shared/src/shard.ts'
import {
	RECORDS_VERSION,
	readManifests,
	loadRecords,
	recordedPaths,
	type StoredRecords,
	select,
	type Affects,
	type Decision,
	type Records,
} from './core.ts'
import {
	alwaysPaths,
	anchorFile,
	currentTree,
	readJson,
	recordsFile,
	restore,
	toRelative,
	type Anchor,
} from './project.ts'
import { affecting } from './narrow.ts'
import { recordGlobals } from './record.ts'
import { log, resolveFromJest, state, type Pending } from './state.ts'

/**
 * The `testSequencer`: Jest hands it every test file it is about to run, and
 * runs the ones it returns. `shard` assigns files by a hash of their path, so
 * a file stays in its shard as files come and go; `sort` drops the files the
 * change does not affect and leaves the order to Jest's own sequencer.
 */
interface Test {
	path: string
	context?: {
		resolver?: { resolveModule?: (from: string, specifier: string) => string }
	}
}

interface SequencerClass {
	new (...args: unknown[]): { sort(tests: Test[]): Test[] | Promise<Test[]> }
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

	// Jest 30 passes `{ contexts, globalConfig }`; Jest 29 passes nothing.
	constructor(...args: unknown[]) {
		super(...args)
		this.blacksmithConfig = (
			args[0] as { globalConfig?: GlobalConfig } | undefined
		)?.globalConfig
	}

	shard(
		tests: Test[],
		options: { shardIndex: number; shardCount: number },
	): Test[] {
		const ctx = state()
		ctx.shard = { index: options.shardIndex, count: options.shardCount }
		return tests.filter(
			(test) =>
				shardFor(toRelative(ctx.repo, test.path), options.shardCount) ===
				options.shardIndex - 1,
		)
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
			tests.flatMap((test) => test.context?.resolver ?? []),
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
	await restore(ctx, shard)
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
