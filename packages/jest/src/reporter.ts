import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	rmSync,
} from 'node:fs'
import path from 'node:path'

import {
	mergeRecords,
	type FileRecord,
	type Records,
	type RunRecord,
	type TestState,
} from './core.ts'
import {
	alwaysPaths,
	readJson,
	recordsFile,
	save,
	toRelative,
	writeRecords,
} from './project.ts'
import { endGlobals, type Piece } from './record.ts'
import { ENV_RECORD, log, state } from './state.ts'

/**
 * The reporter: collects how each test ended, and when the run is over joins
 * that with what the processes running the test files recorded, merges it
 * into the record and saves the record to the Actions cache.
 */
interface AssertionResult {
	fullName: string
	status: string
}

interface TestResult {
	testFilePath: string
	testResults: AssertionResult[]
	testExecError?: unknown
	failureMessage?: string | null
	numFailingTests?: number
}

interface GlobalConfig {
	testNamePattern?: string
	watch?: boolean
	watchAll?: boolean
}

export default class BlacksmithReporter {
	private readonly results = new Map<string, TestResult[]>()
	private readonly partial: boolean
	private readonly watching: boolean

	constructor(globalConfig: GlobalConfig) {
		this.partial = Boolean(globalConfig.testNamePattern)
		this.watching = Boolean(globalConfig.watch || globalConfig.watchAll)
	}

	onRunStart(): void {
		endGlobals()
	}

	onTestResult(_test: unknown, result: TestResult): void {
		const file = toRelative(state().repo, result.testFilePath)
		this.results.set(file, [...(this.results.get(file) ?? []), result])
	}

	async onRunComplete(): Promise<void> {
		const root = process.env[ENV_RECORD]
		try {
			if (!this.watching) await this.commit(root)
		} catch (error) {
			log(
				`record not updated: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			if (root) rmSync(root, { recursive: true, force: true })
		}
	}

	private async commit(root: string | undefined): Promise<void> {
		const ctx = state()
		const pending = ctx.pending
		ctx.pending = null
		if (!pending || !root) return
		const { deps, global, manifests } = readPieces(root, ctx.repo)
		const run: RunRecord = {
			at: Date.now(),
			global,
			files: {},
			partial: this.partial,
		}
		for (const [file, results] of this.results) {
			const recorded = deps.get(file)
			const tests: Record<string, TestState> = {}
			let failed = recorded === undefined
			for (const result of results) {
				// A file that failed outside its tests reports no test, or tests that never ran.
				if (
					result.testExecError ||
					(result.failureMessage && !result.numFailingTests)
				) {
					failed = true
				}
				for (const test of result.testResults) {
					if (test.status === 'failed') tests[test.fullName] = 'failed'
					else if (test.status === 'passed') tests[test.fullName] ??= 'passed'
					// With `-t`, the tests the pattern leaves out are reported as pending too.
					else if (!this.partial) tests[test.fullName] ??= 'skipped'
				}
			}
			const entry: FileRecord = { deps: [...(recorded ?? [])].sort(), tests }
			const read = [...(manifests.get(file) ?? [])].sort()
			if (read.length > 0) entry.manifests = read
			if (failed) entry.failed = true
			run.files[file] = entry
		}
		// A changed lockfile or config is in no test file's dependencies, yet
		// stales every record: a file this run left out keeps none.
		const always = new Set(alwaysPaths(ctx))
		const staleAll = pending.changed.some((file) => always.has(file))
		const merged = mergeRecords(
			staleAll ? null : readJson<Records>(recordsFile(ctx, pending.shard)),
			run,
			pending.changed,
			ctx.options,
		)
		for (const spec of Object.keys(merged.files)) {
			if (!existsSync(path.join(ctx.repo, spec))) delete merged.files[spec]
		}
		const anchored = await writeRecords(ctx, pending.shard, merged)
		const entries = Object.values(merged.files)
		const vouched = entries.filter(
			(entry) =>
				!entry.failed && !Object.values(entry.tests).includes('failed'),
		).length
		log(
			`record: ${vouched} of ${entries.length} test file(s) vouched for, ${anchored} path(s) anchored`,
		)
		await save(ctx, pending.shard)
	}
}

/** Config files of Babel, SWC and TypeScript, wherever they are. */
const TRANSFORM_CONFIG =
	/^(\.babelrc(\.\w+)?|babel\.config\.\w+|\.babelignore|\.browserslistrc|\.browserlistrc|browserslist|browserlist|\.swcrc|tsconfig(\..+)?\.json)$/

/** What the processes of the run wrote under `root`, repository-relative: each test file's dependencies, and the files all depend on. */
function readPieces(
	root: string,
	repo: string,
): {
	deps: Map<string, Set<string>>
	global: string[]
	manifests: Map<string, Set<string>>
} {
	const manifests = new Map<string, Set<string>>()
	const deps = new Map<string, Set<string>>()
	const global = new Set<string>()
	const isDirectory = (file: string): boolean =>
		lstatSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false
	const list = (dir: string): string[] => {
		try {
			return readdirSync(dir)
		} catch {
			return []
		}
	}
	for (const name of list(path.join(root, 'tests'))) {
		const piece = readJson<Piece>(path.join(root, 'tests', name))
		if (!piece) continue
		const test = toRelative(repo, piece.test)
		const files = deps.get(test) ?? new Set<string>()
		deps.set(test, files)
		const read = manifests.get(test) ?? new Set<string>()
		manifests.set(test, read)
		for (const file of piece.manifests ?? []) read.add(toRelative(repo, file))
		// Jest's resolver asks about every directory on the way to a module:
		// a file moving into one of them is no change to the test.
		const probes = piece.probes.filter((file) => !isDirectory(file))
		for (const file of [...piece.deps, ...probes]) {
			if (file === piece.test) continue
			// A transformer looks its config up once per directory and process and
			// keeps the answer: the test file that asked is not the only one it shapes.
			if (TRANSFORM_CONFIG.test(path.basename(file)))
				global.add(toRelative(repo, file))
			else files.add(toRelative(repo, file))
		}
	}
	for (const name of list(root)) {
		if (!name.startsWith('global-')) continue
		for (const line of readFileSync(path.join(root, name), 'utf8').split(
			'\n',
		)) {
			if (line !== '') global.add(toRelative(repo, line))
		}
	}
	return { deps, global: [...global].sort(), manifests }
}
