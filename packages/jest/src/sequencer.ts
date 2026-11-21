import { createRequire } from 'node:module'

import { toRelative } from '../../core/src/anchor.ts'
import { describeSelection } from '../../core/src/engine.ts'
import { specKey } from '../../core/src/record.ts'
import { recordGlobals } from './record.ts'
import { log, openSession, projectName, resolveFromJest, state } from './state.ts'

/**
 * The `testSequencer`: Jest hands it every test file it is about to run, and
 * runs the ones it returns. `shard` is Jest's own, over every test file, before
 * any is dropped; `sort` drops the files the
 * change does not affect and leaves the order to Jest's own sequencer.
 */
interface Test {
	path: string
	context?: {
		config?: Parameters<typeof projectName>[0]
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
		const shard = { index: options.shardIndex, count: options.shardCount }
		openSession(ctx).checkShard(
			shard,
			`@useblacksmith/jest: --shard=${shard.index}/${shard.count}`,
			'raise the maxShards option',
		)
		ctx.shard = shard
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
		// A test file several projects have is a test file of each: Jest shards
		// them apart, and the record keeps one per project.
		const projects = new Map<string, Set<unknown>>()
		for (const test of this.everyTest ?? tests) {
			const of = projects.get(test.path) ?? new Set()
			projects.set(test.path, of.add(test.context))
		}
		ctx.shared = new Set(
			[...projects].filter(([, of]) => of.size > 1).map(([file]) => file),
		)
		const keyOf = (test: Test): string =>
			specKey(
				toRelative(ctx.repo, test.path),
				ctx.shared.has(test.path)
					? projectName(test.context?.config, ctx.repo)
					: undefined,
			)
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
			// Coverage of a part of the test files would fail or pass thresholds for the wrong reason.
			const coverage = ctx.coverage || config?.collectCoverage === true
			if (coverage) log('coverage is on: running every test file')
			const pending = await openSession(ctx).plan([...new Set(tests.map(keyOf))], {
				shard: ctx.shard,
				all: coverage ? 'coverage' : undefined,
			})
			ctx.pending = pending
			const [summary = '', ...lines] = describeSelection(pending, 'test file')
			log(summary)
			for (const line of lines) process.stderr.write(`${line}\n`)
			selected = tests.filter(
				(test) => pending.selection[keyOf(test)]?.run !== false,
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
