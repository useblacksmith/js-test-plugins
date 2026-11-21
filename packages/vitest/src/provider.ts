import { existsSync } from 'node:fs'
import path from 'node:path'

import type {
	Reporter,
	TestModule,
	TestProject,
	TestRunEndReason,
	TestSpecification,
	Vitest,
} from 'vitest/node'

import { toRelative } from '../../core/src/anchor.ts'
import { describeSelection, type Pending } from '../../core/src/engine.ts'
import { ENV_RECORD_ROOT } from '../../core/src/fs-recorder.ts'
import { isPackagePath } from '../../core/src/packages.ts'
import type { Records, RunFile, RunRecord } from '../../core/src/record.ts'
import type { Options } from '../../core/src/select.ts'
import type { Entered } from '../../core/src/unitstore.ts'
import { recordBrowserDependencies } from './browser.ts'
import { collectPackages } from './packages.ts'
import {
	DEPENDENCIES_VERSION,
	dependencyStore,
	envFiles,
	pruneRecords,
	readRecords,
	recordedFiles,
	writeRecords,
	type ProjectRecords,
} from './records.ts'
import {
	keyOf,
	ownedSpecifications,
	runState,
	type RunState,
	type Settings,
} from './session.ts'
import { collectEntered } from './units.ts'

/**
 * Vitest's side of the selection. The provider is the VCS provider Vitest
 * asks for the changed files: it asks the shared core which test files have
 * to run and names exactly those. The recorder is a reporter: when the run
 * is over it hands the core what each test file loaded and how it ended.
 * Everything that decides is in the core; here is only what Vitest's API
 * needs said its way.
 */
export const UNSUPPORTED_VITEST =
	'[blacksmith] @useblacksmith/vitest selects changed tests on Vitest 4.1.1 or newer 4.x, or 5.1.0 or newer; upgrade vitest, or set `runAllTests: true` and drop --changed'

/** Vitest's `VCSProviderOptions`; only 5.1 and newer pass a `resolver`, and 4.1 does not export the type. */
interface VCSProviderOptions {
	root: string
	changedSince?: string | boolean
	resolver?: unknown
}

function rootRelative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/')
}

/**
 * Brings the record Vitest keeps (or, before 5.1, the plugin's copy of it)
 * in line with the selection. Vitest 5.1 runs a test file its own record
 * does not know, whatever the changed files are, and a fresh checkout has
 * no such record: a test file left out gets one made from the core's. One
 * that has to run and whose record names nothing that runs it (it never
 * loaded: a syntax error in it or in a setup file) loses the record, since
 * without one Vitest always runs it.
 */
async function alignRecords(
	vitest: Vitest,
	state: RunState,
	core: Records | null,
	specifications: readonly TestSpecification[],
	run: ReadonlySet<string>,
): Promise<void> {
	const dir = vitest.vite.config.cacheDir
	const { root } = vitest.config
	const records = (await readRecords(vitest, dir)) ?? {
		version: DEPENDENCIES_VERSION,
		projects: {},
	}
	let dirty = false
	const indexes = new Map<ProjectRecords, Map<string, number>>()
	const intern = (project: ProjectRecords, files: readonly string[]): number[] => {
		let index = indexes.get(project)
		if (!index) {
			index = new Map(project.modules.map((file, at) => [file, at]))
			indexes.set(project, index)
		}
		const known = index
		return [
			...new Set(
				files.map((file) => {
					const relative = rootRelative(root, file)
					let at = known.get(relative)
					if (at === undefined) {
						at = project.modules.push(relative) - 1
						known.set(relative, at)
					}
					return at
				}),
			),
		]
	}
	const absolute = (files: readonly string[]): string[] =>
		files.filter((file) => !isPackagePath(file)).map((file) => path.join(state.repo, file))
	for (const { moduleId, project } of specifications) {
		const test = rootRelative(root, moduleId)
		const existing = records.projects[project.name]?.files[test]
		if (existing) {
			const entry = records.projects[project.name] as ProjectRecords
			const reruns =
				!run.has(moduleId) ||
				recordedFiles(vitest, entry, existing).some((file) =>
					run.has(file.split(path.sep).join('/')),
				)
			if (!reruns) {
				delete entry.files[test]
				dirty = true
			}
			continue
		}
		const known = core?.files[keyOf(state.repo, moduleId, project.name)]
		if (!known) continue
		const entry = (records.projects[project.name] ??= { modules: [], files: {} })
		entry.files[test] = {
			at: known.at ?? 0,
			deps: intern(entry, [moduleId, ...absolute(known.deps)]),
		}
		// Without a record of its globalSetup Vitest runs the whole project.
		if (project.config.globalSetup.length > 0 && !entry.globalSetup) {
			entry.globalSetup = {
				at: known.at ?? 0,
				deps: intern(entry, absolute(core?.projects[project.name] ?? [])),
			}
		}
		dirty = true
	}
	if (dirty) await writeRecords(vitest, dir, records)
}

const PROVIDER_BRAND = Symbol.for('blacksmith.treeSnapshotProvider')

/** True for a `TreeSnapshotProvider` from any copy of this module (a project with its own root re-evaluates the config file, so it gets its own copy). */
export function isTreeSnapshotProvider(
	value: unknown,
): value is TreeSnapshotProvider {
	return typeof value === 'object' && value !== null && PROVIDER_BRAND in value
}

/** The provider vitest loaded: the root config's `experimental.vcsProvider`, when it is ours. */
export function configuredProvider(
	vitest: Vitest,
): TreeSnapshotProvider | null {
	const configured: unknown = vitest.config.experimental.vcsProvider
	return isTreeSnapshotProvider(configured) ? configured : null
}

export class TreeSnapshotProvider implements Settings {
	readonly [PROVIDER_BRAND] = true
	vitest!: Vitest
	/** The plugin's options the selection reads. */
	options: Options = {}
	narrow = false

	/**
	 * The test files that have to run, which is what Vitest makes of the
	 * changed files on every version: it runs a test file named among them.
	 */
	async findChangedFiles(options: VCSProviderOptions): Promise<string[]> {
		const vitest = this.vitest
		// Vitest 5.1 hands over its record; on an older one the plugin keeps it.
		if (dependencyStore(vitest) === null && !options.resolver) {
			throw new Error(UNSUPPORTED_VITEST)
		}
		const state = await runState(vitest, this)
		const specifications = await ownedSpecifications(vitest)
		const pending = await plan(vitest, state, specifications)
		const [summary = '', ...lines] = describeSelection(pending, 'test file')
		vitest.logger.log(`[blacksmith] ${summary}`)
		for (const line of lines) vitest.logger.log(line)
		const run = new Set<string>()
		for (const { moduleId, project } of specifications) {
			if (pending.selection[keyOf(state.repo, moduleId, project.name)]?.run !== false) {
				run.add(moduleId)
			}
		}
		state.deselected = new Set(
			specifications.map(({ moduleId }) => moduleId).filter((file) => !run.has(file)),
		)
		await alignRecords(
			vitest,
			state,
			state.session.store.readRecords(pending.shard),
			specifications,
			run,
		)
		// Not a changed run any more: vitest's coverage provider narrows its
		// report to `config.related`, which is about to be every test file,
		// and no source file is a test file.
		const decisions = Object.values(pending.selection)
		if (
			pending.trigger !== undefined ||
			decisions.every((decision) => decision.run && decision.reason === 'no record')
		) {
			vitest.config.changed = false
		}
		return [...run]
	}
}

/** Asks the core which of the shard's test files run; `all` when they all do whatever it says, and why. */
async function plan(
	vitest: Vitest,
	state: RunState,
	specifications: readonly TestSpecification[],
	all?: string,
): Promise<Pending> {
	const keys = [
		...new Set(
			specifications.map(({ moduleId, project }) => keyOf(state.repo, moduleId, project.name)),
		),
	]
	state.pending = await state.session.plan(keys, {
		shard: vitest.config.shard ?? null,
		all,
	})
	return state.pending
}

function containsOnly(module: TestModule): boolean {
	return (module as { task?: { containsOnly?: boolean } }).task?.containsOnly === true
}

function isPartialSpecification(specification: TestSpecification): boolean {
	// Not every filter exists on every supported vitest.
	const filters = specification as unknown as Record<string, unknown>
	// A file named without lines carries an empty list.
	const some = (value: unknown): boolean =>
		Array.isArray(value) ? value.length > 0 : value !== undefined
	return (
		some(filters.testLines) ||
		some(filters.testIds) ||
		some(filters.testNames) ||
		filters.testNamePattern !== undefined ||
		filters.testTagsFilter !== undefined
	)
}

/** Whether the run is already set to exit non-zero. */
function failing(): boolean {
	return process.exitCode !== undefined && process.exitCode !== 0
}

const RECORDER_BRAND = Symbol.for('blacksmith.snapshotRecorder')

/** True for a `SnapshotRecorder` from any copy of this module (a project's config bundles its own). */
export function isSnapshotRecorder(reporter: unknown): boolean {
	return (
		typeof reporter === 'object' &&
		reporter !== null &&
		RECORDER_BRAND in reporter
	)
}

interface Recorded {
	pending: Pending
	run: RunRecord
	entered: Map<string, Entered>
}

/** Hands the core what the run recorded, once it is known how the run ended. */
export class SnapshotRecorder implements Reporter {
	readonly [RECORDER_BRAND] = true
	private vitest!: Vitest
	private started = new Set<string>()
	private partial = false
	/** What a run recorded, kept until its coverage thresholds have passed. */
	private waiting: Recorded | null = null
	/** Worker records being read into the plugin's own store. */
	private ended: TestModule[] = []

	constructor(
		private readonly provider: TreeSnapshotProvider,
		private readonly options: {
			/** Run everything and say what the selection would have run. */
			shadow?: boolean
		} = {},
	) {}

	/** The provider vitest is using: the root config's, which may come from another copy of this module. */
	private settings(): Settings {
		return configuredProvider(this.vitest) ?? this.provider
	}

	private state(): Promise<RunState> {
		return runState(this.vitest, this.settings())
	}

	/**
	 * What the selection decided. A run that did not ask the provider (every
	 * test runs: coverage, `runAllTests`, shadow mode) still reads the
	 * record, which its own adds to.
	 */
	private async planned(): Promise<Pending> {
		const state = await this.state()
		if (state.pending) return state.pending
		return plan(
			this.vitest,
			state,
			await ownedSpecifications(this.vitest),
			this.options.shadow ? undefined : 'every test runs',
		)
	}

	/** Shadow mode's verdict for this run, logged once the run has finished. */
	private async reportShadow(modules: ReadonlyArray<TestModule>): Promise<void> {
		if (!this.options.shadow) return
		const log = (message: string) =>
			this.vitest.logger.log(`[blacksmith] shadow: ${message}`)
		const state = await this.state()
		const pending = await this.planned()
		const decisions = Object.values(pending.selection)
		if (decisions.every((decision) => decision.run && decision.reason === 'no record')) {
			log('nothing to compare against (no record)')
			return
		}
		const ran = this.started
		const would = new Set(
			(await ownedSpecifications(this.vitest))
				.filter(
					({ moduleId, project }) =>
						ran.has(moduleId) &&
						pending.selection[keyOf(state.repo, moduleId, project.name)]?.run !== false,
				)
				.map(({ moduleId }) => moduleId),
		)
		const why =
			pending.trigger === undefined
				? `${pending.changed.length} files changed`
				: `everything: ${pending.trigger} changed`
		log(`would have run ${would.size} of ${ran.size} test files (${why})`)
		const failed = modules
			.filter((module) => module.state() === 'failed' || module.errors().length > 0)
			.map((module) => module.moduleId)
		if (failed.length === 0) return
		const outside = failed.filter((file) => !would.has(file))
		if (outside.length === 0) {
			log(`all ${failed.length} failed test files were in the selection`)
			return
		}
		const root = this.vitest.config.root
		log(
			`${outside.length} failed test files outside the selection: ${outside
				.map((file) => path.relative(root, file))
				.join(', ')}`,
		)
	}

	/** How many of the shard's test files the selection left out, logged once the run has finished. */
	private async reportFiltered(): Promise<void> {
		if (this.options.shadow) return
		const { deselected } = await this.state()
		// Vitest reports every shard's specifications as started.
		const owned = new Set(
			(await ownedSpecifications(this.vitest)).map(({ moduleId }) => moduleId),
		)
		let ran = 0
		let filtered = 0
		for (const file of owned) {
			if (this.started.has(file)) ran++
			else if (deselected.has(file)) filtered++
		}
		this.vitest.logger.log(
			`[blacksmith] filtered out ${filtered} of ${ran + filtered} test files as unaffected, ran ${ran}`,
		)
	}

	onInit(vitest: Vitest): void {
		this.vitest = vitest
	}

	async onTestRunStart(specifications: ReadonlyArray<TestSpecification>): Promise<void> {
		this.started = new Set(
			specifications.map((specification) => specification.moduleId),
		)
		this.partial =
			specifications.some(isPartialSpecification) ||
			(this.vitest.config.tagsFilter?.length ?? 0) > 0
		// Before the tests touch anything: the anchor is compared with the files as the run found them.
		await this.planned()
	}

	async onTestModuleEnd(module: TestModule): Promise<void> {
		recordBrowserDependencies(this.vitest, module)
		const store = dependencyStore(this.vitest)
		const root = process.env[ENV_RECORD_ROOT]
		if (store && root && !module.project.isBrowserEnabled()) {
			this.ended.push(module)
		}
	}

	async onTestRunEnd(
		modules: ReadonlyArray<TestModule>,
		errors: ReadonlyArray<unknown>,
		reason: TestRunEndReason,
	): Promise<void> {
		await this.reportShadow(modules)
		const store = dependencyStore(this.vitest)
		const cut =
			this.partial ||
			this.vitest.getGlobalTestNamePattern() !== undefined ||
			reason === 'interrupted'
		if (store) {
			// At the end of the run, not of the module: a worker finishes a
			// file's record when it starts its next file or exits.
			const root = process.env[ENV_RECORD_ROOT]
			if (root) {
				await Promise.all(
					this.ended.splice(0).map((module) => store.collect(module, root)),
				)
			}
			await store.update(modules, (module) => cut || containsOnly(module))
		}
		const recorded = await this.recorded(modules, cut)
		await this.reportFiltered()
		// An interrupted run left files unrun, and an unhandled error fails the
		// run outside any module (`reason` does not see it): neither says
		// anything the record can keep.
		if (reason === 'interrupted' || errors.length > 0) return
		// Nothing owned (an `include` matching no file) records nothing.
		if (recorded.pending.owned.length === 0) return
		const failed = Object.values(recorded.run.files).filter((file) => file.failed).length
		if (failed > 0) {
			this.vitest.logger.log(
				`[blacksmith] ${failed} failed test files run again next time`,
			)
		}
		// Vitest checks coverage thresholds after this hook and fails the run
		// through the exit code alone; the record waits for that verdict. A run
		// already failing hides it, and records now so its failed tests rerun.
		if (this.checksThresholds(modules) && !failing()) {
			this.waiting = recorded
			return
		}
		await this.commit(recorded)
	}

	/** Whether vitest is about to report coverage and check `coverage.thresholds`. */
	private checksThresholds(modules: ReadonlyArray<TestModule>): boolean {
		const coverage = this.vitest.config.coverage
		if (!coverage.enabled || !coverage.thresholds) return false
		return (
			coverage.reportOnFailure === true ||
			modules.every((module) => module.ok())
		)
	}

	/** Called by vitest once coverage is reported and its thresholds checked. */
	async onFinishedReportCoverage(): Promise<void> {
		const recorded = this.waiting
		this.waiting = null
		if (recorded === null) return
		if (failing()) {
			this.vitest.logger.log(
				'[blacksmith] coverage thresholds failed, the dependency record vouches for no test of this run and the next run runs them all',
			)
			for (const file of Object.values(recorded.run.files)) file.failed = true
		}
		await this.commit(recorded)
	}

	private async commit({ pending, run, entered }: Recorded): Promise<void> {
		const state = await this.state()
		state.pending = null
		const { records, vouched, anchored } = await state.session.commit(pending, [run], {
			...(this.settings().narrow ? { entered } : {}),
		})
		this.vitest.logger.log(
			`[blacksmith] record: ${vouched} of ${Object.keys(records.files).length} test file(s) vouched for, ${anchored} path(s) anchored`,
		)
	}

	/** What the run recorded, in the core's terms: each test file's dependencies and whether it passed. */
	private async recorded(
		modules: ReadonlyArray<TestModule>,
		cut: boolean,
	): Promise<Recorded> {
		const vitest = this.vitest
		const state = await this.state()
		const pending = await this.planned()
		const { repo } = state
		const { root } = vitest.config
		const recordRoot = process.env[ENV_RECORD_ROOT]
		await pruneRecords(vitest, repo, vitest.vite.config.cacheDir)
		const native = await readRecords(vitest, vitest.vite.config.cacheDir)
		const packages = await collectPackages(
			vitest,
			repo,
			recordRoot,
			modules
				.filter((module) => module.project.config.browser.enabled)
				.map((module) => module.moduleId),
		)
		const units = this.settings().narrow ? await collectEntered(repo, recordRoot) : null
		// The anchor cannot cover what is outside the repository.
		const inRepo = (files: readonly string[]): string[] => [
			...new Set(
				files
					.map((file) => toRelative(repo, file))
					.filter((file) => file !== '' && !file.startsWith('..') && !path.isAbsolute(file)),
			),
		]
		const setup = (project: TestProject): string[] => {
			const record = native?.projects[project.name]
			return record ? recordedFiles(vitest, record, record.globalSetup) : []
		}
		const config = (project: TestProject | Vitest): string[] => {
			const { configFile, configFileDependencies } = project.vite.config
			return [...(configFile ? [configFile] : []), ...configFileDependencies].filter((file) =>
				existsSync(file),
			)
		}
		const run: RunRecord = {
			at: Date.now(),
			// The root's config shapes every project, and its globalSetup runs
			// for every project, recorded under the root project even when
			// that one has no tests of its own.
			global: [
				...inRepo([...config(vitest), ...setup(vitest.getRootProject())]),
				...packages.global,
			],
			projects: {},
			files: {},
		}
		const entered = new Map<string, Entered>()
		for (const module of modules) {
			const { project, moduleId } = module
			const test = toRelative(repo, moduleId)
			const key = keyOf(repo, moduleId, project.name)
			// Env files stay in when absent: one created later is a change.
			run.projects![project.name] ??= inRepo([
				...config(project),
				...envFiles(project),
				...setup(project),
			])
			const records = native?.projects[project.name]
			const record = records?.files[rootRelative(root, moduleId)]
			const state = module.state()
			const fine =
				(state === 'passed' || state === 'skipped') && module.errors().length === 0
			const partial = cut || containsOnly(module)
			const entry: RunFile = {
				deps: [
					...inRepo(records ? recordedFiles(vitest, records, record) : []).filter(
						(file) => file !== test,
					),
					...(packages.files.get(test) ?? []),
				],
				tests: {},
			}
			// A test file without a record of what it loaded never got to its hooks: it runs next time.
			if (!fine || !record) entry.failed = true
			if (partial) entry.partial = true
			if (packages.incomplete.has(test)) entry.incomplete = true
			run.files[key] = entry
			entered.set(key, { ran: units?.get(test), partial })
		}
		return { pending, run, entered }
	}
}
