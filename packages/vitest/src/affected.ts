import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import picomatch from 'picomatch'

import { recordBrowserDependencies } from './browser.js'
import { ENV_RECORD_ROOT } from '../../shared/src/fs-recorder.js'
import {
	dependencyStore,
	envFiles,
	type DependencyRecord,
	type DependencyRecords,
	recordsPath,
} from './records.js'
import {
	cacheKey,
	ENV_CACHE_URL,
	cacheMode,
	restoreBundle,
	runtimeId,
	saveBundle,
} from './cache.js'

import type {
	Reporter,
	TestModule,
	TestRunEndReason,
	TestSpecification,
	Vitest,
} from 'vitest/node'

import {
	anchorTree,
	blobsAt,
	diffTrees,
	headSha,
	knownPaths,
	lockfilePaths,
	pathsUnder,
	repoRoot,
	type Tree,
} from '../../shared/src/git.js'
import { shardOwner } from './sequencer.js'
import { mergeRecords } from './merge.js'
import { readPackages, updatePackages } from './packages.js'
import { advanceDigests, narrowing, unitsFile, updateUnits } from './units.js'
import {
	isPackagePath,
	manifestShape,
	packageVersion,
} from '../../shared/src/packages.js'

export const SNAPSHOT_FILE = 'blacksmith.json'
export const UNSUPPORTED_VITEST =
	'[blacksmith] @useblacksmith/vitest selects changed tests on Vitest 4.1.1 or newer 4.x, or 5.1.0 or newer; upgrade vitest, or set `runAllTests: true` and drop --changed'
// Bumped whenever the snapshot's shape changes or the records an anchor
// vouches for gain a kind of dependency, so an older snapshot is not trusted.
const SNAPSHOT_VERSION = 10

/** A `dependencies` entry, compiled: test files matching `tests` depend on files matching `deps`; both root-relative. */
export interface DependencyRule {
	/** The `tests` glob as written, for messages. */
	source: string
	tests: (file: string) => boolean
	deps: (file: string) => boolean
	/** Root-relative directories the `deps` globs start in (`fixtures` for `fixtures/**`), where git-ignored files are looked for; a glob with no fixed start has none. */
	bases: string[]
}

/**
 * A glob written as a path from the root (`../../packages/*\/package.json`
 * from `packages/a`) in the form candidates take, `../*\/package.json`:
 * `path.relative` folds the `..` segments the same way for both.
 */
function normalizeGlob(root: string, glob: string): string {
	if (!/^\.\.?\//.test(glob)) return glob
	return rootRelative(root, path.resolve(root, glob))
}

export function compileDependencies(
	dependencies:
		Readonly<Record<string, string | readonly string[]>> | undefined,
	root: string,
): DependencyRule[] {
	return Object.entries(dependencies ?? {}).map(([tests, deps]) => {
		const globs = (typeof deps === 'string' ? [deps] : [...deps]).map((glob) =>
			normalizeGlob(root, glob),
		)
		return {
			source: tests,
			tests: picomatch(normalizeGlob(root, tests), { dot: true }),
			deps: picomatch(globs, { dot: true }),
			bases: globs
				.map((glob) => picomatch.scan(glob).base)
				.filter((base) => base !== '' && base !== '.'),
		}
	})
}

/** `file` relative to the config root with `/` separators, the form the `dependencies` globs match. */
function rootRelative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/')
}

/** `file` relative to the repository with `/` separators (git's form, whatever path.sep is); `tree` and `tests` are keyed by it. */
function repoRelative(repo: string, file: string): string {
	return path.relative(repo, file).split(path.sep).join('/')
}

export interface Shard {
	index: number
	count: number
}

/**
 * Written beside vitest's `dependencies.json` after a run that covered every
 * test the shard owns; `tree` anchors every path the dependency records name.
 */
export interface Snapshot {
	version: typeof SNAPSHOT_VERSION
	/** Node major, platform and arch the run was made on; another one does not share its skips. */
	runtime: string
	head: string
	/** When it was written, in milliseconds: of two entries that vouch for a test file, the later one is used. */
	at: number
	/** Vitest's root relative to the repository, so one package's snapshot never vouches for another's. */
	root: string
	shard: Shard | null
	/** The workflow file and job the run was part of (see `jobId`), '' outside Actions; another job's `env` and steps differ, so it does not share its skips. */
	job: string
	/** Names of the projects the run covered (`--project` narrows them). */
	projects: string[]
	tree: Tree
	/** Repo-relative test files the run vouches for, sorted: passed, or deselected by our provider as unchanged. A test outside this set (never run, failed, interrupted) reruns whatever its record says. */
	tests: string[]
	/** When each of `tests` last passed or was found unaffected by the shard that owns it, in milliseconds: of the entries that vouch for a test file, the one with the latest time is used. One missing here has `at`. */
	times: Record<string, number>
	/**
	 * Test files that were left out (failed, or never reached) and when: an
	 * entry that vouches for one from before then is not used for it, so it
	 * runs again. Another shard's entry keeps what it has seen of these.
	 */
	left: Record<string, number>
}

const LOCKFILES = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
])

/**
 * Package manifests and TypeScript configs on the way up from a recorded
 * file to the repository root: `exports`, `imports`, `type`, `paths` and the
 * like change what a module resolves to without any recorded file changing.
 */
function isManifest(file: string): boolean {
	const base = path.basename(file)
	return base === 'package.json' || /^tsconfig(\..+)?\.json$/.test(base)
}

/**
 * The workflow file running this job, when it lives in this repository. Its
 * `matrix`, `env` and steps shape every test, so a change to it runs them all.
 */
function workflowPath(): string | null {
	const ref = process.env.GITHUB_WORKFLOW_REF
	const repository = process.env.GITHUB_REPOSITORY
	if (!ref || !repository || !ref.startsWith(`${repository}/`)) return null
	const file = ref.slice(repository.length + 1).split('@')[0] ?? ''
	return file.startsWith('.github/workflows/') ? file : null
}

/**
 * The workflow file and job this run is part of, `.github/workflows/ci.yml#test`;
 * '' outside Actions. Two jobs run the same tests under different `env` and
 * steps, so neither trusts the other's snapshot or restores its cache entry.
 */
export function jobId(): string {
	const workflow = workflowPath()
	const job = process.env.GITHUB_JOB
	return workflow || job ? `${workflow ?? ''}#${job ?? ''}` : ''
}

/** `dir` and every parent up to the repository root, repo-relative ('' for the root). */
function ancestors(dir: string): string[] {
	const result: string[] = []
	for (let current = dir; ; ) {
		if (current === '.' || current === '') {
			result.push('')
			return result
		}
		result.push(current)
		const parent = path.dirname(current)
		if (parent === current) return result
		current = parent
	}
}

function repoDir(file: string): string {
	const dir = path.dirname(file)
	return dir === '.' ? '' : dir
}

function projectNames(vitest: Vitest): string[] {
	return vitest.projects.map((project) => project.name).sort()
}

/**
 * `blacksmith.json`, or `blacksmith[.<hash>][.<i>of<n>].json` when `--project`
 * narrowed the run or `--shard` split it: invocations covering different
 * project sets or shards keep separate anchors, as their cache keys do.
 */
export function snapshotPath(vitest: Vitest, dir: string): string {
	const parts = [SNAPSHOT_FILE.replace('.json', '')]
	if (vitest.config.project.length > 0) {
		parts.push(
			createHash('sha1')
				.update(projectNames(vitest).join('\n'))
				.digest('hex')
				.slice(0, 12),
		)
	}
	const { shard } = vitest.config
	if (shard) parts.push(`${shard.index}of${shard.count}`)
	return path.join(dir, `${parts.join('.')}.json`)
}

/** The dependency record (vitest's, or the plugin's own on a vitest that keeps none), or `null` before the first recorded run. */
async function readRecords(
	vitest: Vitest,
	dir: string,
): Promise<DependencyRecords | null> {
	const file = recordsPath(vitest, dir)
	try {
		return JSON.parse(await readFile(file, 'utf8')) as DependencyRecords
	} catch {
		return null
	}
}

/** Recorded test file → the files it was seen importing, both absolute; empty when vitest has no records yet. */
async function recordedDependencies(
	vitest: Vitest,
	dir: string,
): Promise<Map<string, Set<string>>> {
	const records = await readRecords(vitest, dir)
	if (!records) return new Map()
	const result = new Map<string, Set<string>>()
	for (const project of Object.values(records.projects ?? {})) {
		// Vitest records every project's paths relative to the root config's root.
		const root = vitest.config.root
		for (const [test, record] of Object.entries(project.files)) {
			// A test file two projects share keeps the dependencies of both.
			const file = path.resolve(root, test)
			const deps = result.get(file) ?? new Set<string>()
			for (const index of record.deps) {
				deps.add(path.resolve(root, project.modules[index] ?? ''))
			}
			result.set(file, deps)
		}
	}
	return result
}

/**
 * Repo-relative paths the anchor covers: every module vitest's records name
 * (imports, fs reads, config and globalSetup files), every recorded test
 * file, lockfiles, and every file a `dependencies` rule names (nothing reads
 * those, so the anchor is the only way a change to them is seen).
 */
async function anchoredPaths(
	vitest: Vitest,
	repo: string,
	dir: string,
	rules: readonly DependencyRule[],
): Promise<string[]> {
	const paths = new Set<string>()
	const workflow = workflowPath()
	if (workflow) paths.add(workflow)
	const records = await readRecords(vitest, dir)
	const dirs = new Set<string>()
	for (const project of Object.values(records?.projects ?? {})) {
		// Vitest records every project's paths relative to the root config's root.
		const root = vitest.config.root
		for (const file of [...project.modules, ...Object.keys(project.files)]) {
			const relative = repoRelative(repo, path.resolve(root, file))
			paths.add(relative)
			// Outside the repository (`..`, or another drive on Windows): no manifest above it is ours.
			if (relative.startsWith('..') || path.isAbsolute(relative)) continue
			for (const dir of ancestors(repoDir(relative))) dirs.add(dir)
		}
	}
	// A lockfile pins what the tests below it resolve; a vendored repo's or a
	// fixture's lockfile pins nothing a test loads.
	for (const file of await lockfilePaths(repo, LOCKFILES)) {
		if (dirs.has(repoDir(file))) paths.add(file)
	}
	const matched = rules.map(() => 0)
	// Git-ignored files (generated code, downloaded fixtures) a rule names are
	// looked up under the directories its globs start in, never repo-wide.
	const bases = new Set<string>()
	for (const rule of rules) {
		for (const base of rule.bases) {
			const relative = repoRelative(repo, path.resolve(vitest.config.root, base))
			if (
				relative !== '' &&
				!relative.startsWith('..') &&
				!path.isAbsolute(relative)
			) {
				bases.add(relative)
			}
		}
	}
	const candidates = await knownPaths(repo)
	for (const file of await pathsUnder(repo, [...bases])) {
		if (!file.split('/').includes('node_modules')) candidates.add(file)
	}
	for (const file of candidates) {
		const fromRoot = rootRelative(vitest.config.root, path.join(repo, file))
		let byRule = false
		rules.forEach((rule, index) => {
			if (!rule.deps(fromRoot)) return
			matched[index] = (matched[index] ?? 0) + 1
			byRule = true
		})
		if (byRule) paths.add(file)
		else if (isManifest(file) && dirs.has(repoDir(file))) paths.add(file)
	}
	rules.forEach((rule, index) => {
		if (matched[index] === 0) {
			vitest.logger.warn(
				`[blacksmith] dependencies["${rule.source}"] matches no file in the repository; globs are relative to ${vitest.config.root}`,
			)
		}
	})
	return [...paths]
}

/**
 * The tree the anchor compares: file content for the anchored paths, the
 * installed version for each package a test file or the run loaded, and for
 * a package.json no test read itself everything but its dependency fields
 * (the packages say whether an install changed anything).
 */
async function currentTree(
	vitest: Vitest,
	repo: string,
	dir: string,
	rules: readonly DependencyRule[],
): Promise<Tree> {
	const tree = await anchorTree(
		repo,
		await anchoredPaths(vitest, repo, dir, rules),
	)
	const read = new Set<string>()
	const records = await readRecords(vitest, dir)
	for (const project of Object.values(records?.projects ?? {})) {
		for (const file of project.modules) {
			read.add(repoRelative(repo, path.resolve(vitest.config.root, file)))
		}
	}
	for (const file of Object.keys(tree)) {
		if (path.posix.basename(file) !== 'package.json' || read.has(file)) continue
		const shape = manifestShape(path.join(repo, file))
		if (shape !== null) tree[file] = shape
	}
	const packages = await readPackages(dir)
	// Once per package: most test files load the same ones.
	for (const file of new Set([
		...(packages?.global ?? []),
		...Object.values(packages?.files ?? {}).flat(),
	])) {
		const version = packageVersion(path.join(repo, file))
		if (version !== null) tree[file] = version
	}
	return tree
}

/**
 * Rewrites the dependency record without the modules outside the
 * repository (the anchor cannot cover them) and without tests that no longer
 * exist, renumbering what the remaining records point to. Vitest only ever
 * appends, so a record otherwise grows by every temp file a run touched.
 */
async function pruneRecords(
	vitest: Vitest,
	repo: string,
	dir: string,
): Promise<void> {
	const records = await readRecords(vitest, dir)
	if (!records) return
	const root = vitest.config.root
	for (const project of Object.values(records.projects ?? {})) {
		const keep = new Map<number, number>()
		const modules: string[] = []
		const renumber = (record: DependencyRecord): void => {
			record.deps = [
				...new Set(
					record.deps.flatMap((index) => {
						const module = project.modules[index]
						if (module === undefined) return []
						const absolute = path.resolve(root, module)
						if (
							repoRelative(repo, absolute).startsWith('..') ||
							path.isAbsolute(repoRelative(repo, absolute))
						) {
							return []
						}
						let next = keep.get(index)
						if (next === undefined) {
							next = modules.push(module) - 1
							keep.set(index, next)
						}
						return [next]
					}),
				),
			]
		}
		for (const [test, record] of Object.entries(project.files)) {
			if (!existsSync(path.resolve(root, test))) {
				delete project.files[test]
				continue
			}
			renumber(record)
		}
		if (project.config) renumber(project.config)
		if (project.globalSetup) renumber(project.globalSetup)
		project.modules = modules
	}
	const file = recordsPath(vitest, dir)
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(records))
	await rename(tmp, file)
}

/**
 * Vitest reruns a recorded test only when a file in its record changed. A
 * test that never loaded (a syntax error in it or in a setup file) has a
 * record that may name nothing, not even the test itself, so handing vitest
 * the test as changed runs nothing. Without a record vitest always runs it.
 */
async function dropUnloadedRecords(
	vitest: Vitest,
	dir: string,
	changed: ReadonlySet<string>,
): Promise<void> {
	const records = await readRecords(vitest, dir)
	if (!records) return
	const root = vitest.config.root
	let dropped = false
	for (const project of Object.values(records.projects ?? {})) {
		for (const [test, record] of Object.entries(project.files)) {
			if (!changed.has(path.resolve(root, test))) continue
			const reruns = record.deps.some((index) =>
				changed.has(path.resolve(root, project.modules[index] ?? '')),
			)
			if (reruns) continue
			delete project.files[test]
			dropped = true
		}
	}
	if (!dropped) return
	const file = recordsPath(vitest, dir)
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(records))
	await rename(tmp, file)
}

/** Whether the run is already set to exit non-zero. */
function failing(): boolean {
	return process.exitCode !== undefined && process.exitCode !== 0
}

function sameShard(a: Shard | null, b: Shard | undefined): boolean {
	if (a === null) return b === undefined
	return b !== undefined && a.index === b.index && a.count === b.count
}

function describeShard(shard: Shard | null | undefined): string {
	return shard ? `shard ${shard.index}/${shard.count}` : 'unsharded run'
}

function isShard(value: unknown): value is Shard | null {
	if (value === null) return true
	if (typeof value !== 'object') return false
	const { index, count } = value as Record<string, unknown>
	return typeof index === 'number' && typeof count === 'number'
}

function isTree(value: unknown): value is Tree {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.values(value).every((sha) => typeof sha === 'string')
	)
}

/** `null` for a missing, truncated or otherwise unusable file, which callers treat as "run everything". */
async function readSnapshot(file: string): Promise<Snapshot | null> {
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(file, 'utf8'))
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const { version, runtime, head, at, root, shard, job, projects, tree, tests, times, left } =
		parsed as Record<string, unknown>
	if (
		version !== SNAPSHOT_VERSION ||
		typeof runtime !== 'string' ||
		typeof head !== 'string' ||
		typeof at !== 'number' ||
		typeof root !== 'string' ||
		!isShard(shard) ||
		typeof job !== 'string' ||
		!Array.isArray(projects) ||
		!projects.every((name) => typeof name === 'string') ||
		!isTree(tree) ||
		!Array.isArray(tests) ||
		!tests.every((file) => typeof file === 'string') ||
		typeof times !== 'object' ||
		times === null ||
		!Object.values(times).every((time) => typeof time === 'number') ||
		typeof left !== 'object' ||
		left === null ||
		!Object.values(left).every((time) => typeof time === 'number')
	) {
		return null
	}
	return {
		version: SNAPSHOT_VERSION,
		runtime,
		head,
		at,
		root,
		shard,
		job,
		projects: projects as string[],
		tree,
		tests: tests as string[],
		times: times as Record<string, number>,
		left: left as Record<string, number>,
	}
}

/**
 * Decides which files changed since the snapshot was written by diffing the
 * stored anchor against the recorded paths as they are now. Falls back
 * to "everything" whenever the snapshot cannot vouch for this shard.
 */
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

/** Vitest's `VCSProviderOptions`; only 5.1 and newer pass a `resolver`, and 4.1 does not export the type. */
interface VCSProviderOptions {
	root: string
	changedSince?: string | boolean
	resolver?: {
		getDependencies(): Promise<
			Array<{ file: string; recordedAt?: number | undefined }>
		>
	}
}

export class TreeSnapshotProvider {
	readonly [PROVIDER_BRAND] = true
	vitest!: Vitest
	/**
	 * Recorded test files none of whose recorded imports changed: the provider
	 * vouches that they need not run, whatever filters the run also applies.
	 */
	deselected = new Set<string>()
	/**
	 * Test files of other shards that the entry this run replaces vouched
	 * for, and that nothing changed for since: the run's own entry keeps
	 * vouching for them, or the shard that owns them now would find no record.
	 */
	carried = new Map<string, number>()
	/** Test files of other shards that were left out, and when: the run's own entry passes that on. */
	left = new Map<string, number>()
	/** The plugin's `dependencies` option, compiled. */
	dependencies: DependencyRule[] = []
	/** Whether to look inside a changed file instead of rerunning every test file that loaded it. */
	narrow = false

	/**
	 * Paths whose content differs from the snapshot's. A path the snapshot did
	 * not anchor (a later run recorded it, or a file it imported was recorded
	 * after another shard's run) is a change only if it was not tracked with
	 * the same blob at the snapshot's commit.
	 */
	private async changedSince(
		repo: string,
		snapshot: Snapshot,
		tree: Tree,
	): Promise<string[]> {
		const changed = diffTrees(snapshot.tree, tree)
		const fresh = changed.filter(
			(file) => !Object.hasOwn(snapshot.tree, file) && Object.hasOwn(tree, file),
		)
		if (fresh.length === 0) return changed
		const blobs = await blobsAt(repo, snapshot.head, fresh)
		if (!blobs) return changed
		return changed.filter((file) => {
			const entry = tree[file]
			const sha = entry?.split(' ')[1]
			return !(blobs.has(file) && blobs.get(file) === sha)
		})
	}

	async findChangedFiles(options: VCSProviderOptions): Promise<string[]> {
		this.deselected = new Set()
		const cacheDir = this.vitest.vite.config.cacheDir
		this.carried = new Map()
		const restored = restoredOf.get(this.vitest)
		this.left = new Map(restored?.left)
		if (restored && restored.entries.length > 0) {
			return this.fromEntries(options, restored.entries)
		}
		// A snapshot that was already here (a cache directory kept between
		// runs) vouches for other shards' test files too: they are decided
		// for like a restored entry's, or the next snapshot would drop them.
		const kept = restored ? null : await this.keptEntry(cacheDir)
		if (kept) return this.fromEntries(options, [kept])
		// Vitest 5.1 hands over its record and selects from the changed files
		// itself; on an older one both are the plugin's.
		const own = dependencyStore(this.vitest) !== null
		if (!own && !options.resolver) throw new Error(UNSUPPORTED_VITEST)
		const specifications = own
			? await this.vitest.globTestSpecifications()
			: []
		const dependencies = options.resolver
			? await options.resolver.getDependencies()
			: await ownDependencies(this.vitest, cacheDir, specifications)
		const selected = await this.select(
			options,
			dependencies,
			cacheDir,
			(message) => this.vitest.logger.log(`[blacksmith] ${message}`),
		)
		if (selected === null) {
			// Not a changed run any more: vitest's coverage provider narrows its
			// report to `config.related`, which is about to be every test file,
			// and no source file is a test file.
			this.vitest.config.changed = false
			return dependencies.map((dependency) => dependency.file)
		}
		const changed = new Set(selected)
		await dropUnloadedRecords(this.vitest, cacheDir, changed)
		for (const [test, deps] of await recordedDependencies(
			this.vitest,
			cacheDir,
		)) {
			if (changed.has(test)) continue
			if ([...deps].some((dep) => changed.has(dep))) continue
			this.deselected.add(test)
		}
		const needs = this.narrow
			? await narrowing(
					await repoRoot(options.root),
					unitsFile(snapshotPath(this.vitest, cacheDir)),
					selected,
				)
			: null
		if (own || needs) {
			const recorded = await recordedDependencies(this.vitest, cacheDir)
			let spared = 0
			const affected = await affectedTests(
				this.vitest,
				selected,
				await readRecords(this.vitest, cacheDir),
				own ? specifications : await this.vitest.globTestSpecifications(),
				needs &&
					((test, changedDeps) => {
						const deps = recorded.get(test)
						if (deps && !needs(test, deps, changedDeps)) {
							this.deselected.add(test)
							spared++
							return false
						}
						return true
					}),
			)
			if (spared > 0) {
				this.vitest.logger.log(
					`[blacksmith] ${spared} test files loaded a changed file but nothing in it that changed, not running them`,
				)
			}
			// Vitest 5.1 would select by file from the changed files; it runs
			// a test file named among them just the same.
			if (!own) return affected.wouldRun === 'all' ? selected : [...affected.wouldRun]
			// Vitest 4.1 runs a test file named among the changed files.
			if (affected.wouldRun !== 'all') return [...affected.wouldRun]
			this.vitest.logger.log(
				`[blacksmith] ${affected.reason}, running every test`,
			)
			this.vitest.config.changed = false
			return specifications.map((specification) => specification.moduleId)
		}
		return selected
	}

	private async keptEntry(dir: string): Promise<CacheEntry | null> {
		const snapshot = await readSnapshot(snapshotPath(this.vitest, dir))
		if (!snapshot) return null
		const repo = await repoRoot(this.vitest.config.root)
		const owns = await shardOwner(this.vitest)
		const tests = new Set<string>()
		const others = new Map<string, number>()
		for (const test of snapshot.tests) {
			const file = path.join(repo, test)
			if (owns(file)) tests.add(file)
			else others.set(file, snapshot.times[test] ?? snapshot.at)
		}
		for (const [test, time] of Object.entries(snapshot.left)) {
			const file = path.join(repo, test)
			if (!owns(file)) this.left.set(file, time)
		}
		if (others.size === 0 && this.left.size === 0) return null
		return { dir, key: '', tests, others }
	}

	/**
	 * The test files to run when the records come from several cache entries,
	 * or from one that also vouches for other shards' test files. Each entry
	 * decides for the test files taken from it, against its own anchor and
	 * with its own records, exactly as a run restoring it alone would. The
	 * same decision says which of the other shards' test files nothing
	 * changed for: the run's own entry goes on vouching for those.
	 */
	private async fromEntries(
		options: VCSProviderOptions,
		entries: readonly CacheEntry[],
	): Promise<string[]> {
		const log = (message: string) =>
			this.vitest.logger.log(`[blacksmith] ${message}`)
		const repo = await repoRoot(options.root)
		const specifications = await this.vitest.globTestSpecifications()
		const run = new Set<string>()
		const taken = new Set<string>()
		let spared = 0
		for (const entry of entries) {
			const only = new Set([...entry.tests, ...entry.others.keys()])
			const theirs = specifications.filter((specification) =>
				only.has(specification.moduleId),
			)
			for (const { moduleId } of theirs) {
				if (entry.tests.has(moduleId)) taken.add(moduleId)
			}
			const selected = await this.select(
				options,
				await ownDependencies(this.vitest, entry.dir, theirs),
				entry.dir,
				log,
				only,
			)
			const recorded = await recordedDependencies(this.vitest, entry.dir)
			const needs =
				selected !== null && this.narrow
					? await narrowing(
							repo,
							unitsFile(snapshotPath(this.vitest, entry.dir)),
							selected,
						)
					: null
			const affected =
				selected === null
					? null
					: await affectedTests(
							this.vitest,
							selected,
							await readRecords(this.vitest, entry.dir),
							theirs,
							needs &&
								((test, changedDeps) => {
									const deps = recorded.get(test)
									if (deps && !needs(test, deps, changedDeps)) {
										if (entry.tests.has(test)) spared++
										return false
									}
									return true
								}),
						)
			if (affected !== null && affected.wouldRun === 'all') {
				log(`${affected.reason}, running every test`)
			}
			const all = affected === null || affected.wouldRun === 'all'
			for (const { moduleId } of theirs) {
				const reruns =
					all || (affected.wouldRun as Set<string>).has(moduleId)
				if (entry.tests.has(moduleId)) {
					if (reruns) run.add(moduleId)
					continue
				}
				const time = entry.others.get(moduleId)
				if (!reruns && time !== undefined) this.carried.set(moduleId, time)
			}
		}
		// A test file no entry vouches for: new, failed last time, or never run.
		const owns = await shardOwner(this.vitest)
		const unvouched = new Set<string>()
		for (const specification of specifications) {
			const file = specification.moduleId
			if (owns(file) && !taken.has(file)) unvouched.add(file)
		}
		for (const file of unvouched) run.add(file)
		if (unvouched.size > 0) {
			log(`${unvouched.size} test files no cache entry vouches for`)
		}
		for (const file of taken) if (!run.has(file)) this.deselected.add(file)
		if (spared > 0) {
			log(
				`${spared} test files loaded a changed file but nothing in it that changed, not running them`,
			)
		}
		await dropUnloadedRecords(
			this.vitest,
			this.vitest.vite.config.cacheDir,
			run,
		)
		return [...run]
	}

	/**
	 * Changed files to hand vitest, or `null` when every test of the shard has
	 * to run; `dir` is where the record and anchor live (vitest's `cacheDir`,
	 * or a shadow run's copy of it).
	 */
	async select(
		{ root }: Pick<VCSProviderOptions, 'root'>,
		dependencies: ReadonlyArray<{
			file: string
			recordedAt?: number | undefined
		}>,
		dir: string,
		log: (message: string) => void,
		/** The test files to decide for, when `dir` holds one of several cache entries: the ones taken from it. */
		only?: ReadonlySet<string>,
	): Promise<string[] | null> {
		const shard = this.vitest.config.shard

		const snapshot = await readSnapshot(snapshotPath(this.vitest, dir))
		if (!snapshot) {
			log(
				`no dependency snapshot, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		const repo = await repoRoot(root)
		const here = repoRelative(repo, this.vitest.config.root)
		if (snapshot.root !== here) {
			log(
				`dependency snapshot is for ${snapshot.root || 'the repository root'}, this run is for ${here || 'the repository root'}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		if (!sameShard(snapshot.shard, shard)) {
			log(
				`dependency snapshot is for ${describeShard(snapshot.shard)}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		const projects = projectNames(this.vitest)
		if (snapshot.projects.join('\n') !== projects.join('\n')) {
			log(
				`dependency snapshot covers projects [${snapshot.projects.join(', ')}], this run covers [${projects.join(', ')}], running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		if (snapshot.job !== jobId()) {
			log(
				`dependency snapshot was made by ${snapshot.job || 'a run outside Actions'}, this is ${jobId() || 'a run outside Actions'}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}
		if (snapshot.runtime !== runtimeId()) {
			log(
				`dependency snapshot was made on ${snapshot.runtime}, this is ${runtimeId()}, running every test of the ${describeShard(shard)}`,
			)
			return null
		}

		const tree = await currentTree(this.vitest, repo, dir, this.dependencies)
		const packages = await readPackages(dir)
		const globalPackages = new Set(packages?.global ?? [])
		const changedPaths = await this.changedSince(repo, snapshot, tree)
		const owns = only
			? (file: string) => only.has(file)
			: await shardOwner(this.vitest)
		// Entries without a record are test files vitest has never seen; a test
		// the snapshot does not vouch for has no trustworthy record either,
		// whatever vitest's dependencies.json holds about it.
		const uncovered = new Set(
			dependencies
				.filter(
					(dependency) =>
						dependency.recordedAt === undefined && owns(dependency.file),
				)
				.map((dependency) => dependency.file),
		)
		const vouched = new Set(snapshot.tests)
		for (const specification of await this.vitest.globTestSpecifications()) {
			const file = specification.moduleId
			if (owns(file) && !vouched.has(repoRelative(repo, file))) {
				uncovered.add(file)
			}
		}
		const changed = new Set(uncovered)
		const workflow = workflowPath()
		const manifestDirs: string[] = []
		const changedPackages = new Set<string>()
		let lockfile = false
		for (const relative of changedPaths) {
			if (relative === workflow || globalPackages.has(relative)) {
				log(
					`${relative} changed, running every test of the ${describeShard(shard)}`,
				)
				return null
			}
			if (isPackagePath(relative)) {
				changedPackages.add(relative)
				continue
			}
			// Still a changed file below: a test that read the lockfile itself reruns.
			if (LOCKFILES.has(path.basename(relative))) lockfile = true
			if (isManifest(relative)) manifestDirs.push(repoDir(relative))
			changed.add(path.join(repo, relative))
		}
		// A manifest changes resolution for everything below it: every test
		// with a recorded file under its directory runs.
		let viaManifest = 0
		if (manifestDirs.length > 0) {
			const under = (file: string): boolean => {
				const relative = repoRelative(repo, file)
				return (
					!relative.startsWith('..') &&
					manifestDirs.some(
						(manifestDir) =>
							manifestDir === '' || relative.startsWith(`${manifestDir}/`),
					)
				)
			}
			for (const [test, deps] of await recordedDependencies(this.vitest, dir)) {
				if (changed.has(test) || !owns(test)) continue
				if (under(test) || [...deps].some(under)) {
					changed.add(test)
					viaManifest++
				}
			}
		}
		// A test file reruns with a package it loaded. One without a list of
		// packages (browser mode, where Vite bundles them), or with one that
		// misses some, reruns with the lockfile.
		const incomplete = new Set(packages?.incomplete ?? [])
		let viaPackages = 0
		if (changedPackages.size > 0 || lockfile) {
			for (const [test] of await recordedDependencies(this.vitest, dir)) {
				if (changed.has(test) || !owns(test)) continue
				const relative = repoRelative(repo, test)
				const loaded = packages?.files[relative]
				if (
					loaded?.some((dir) => changedPackages.has(dir)) ||
					(lockfile && (!loaded || incomplete.has(relative)))
				) {
					changed.add(test)
					viaPackages++
				}
			}
		}
		const triggered = this.dependencies.filter((rule) =>
			changedPaths.some((relative) =>
				rule.deps(rootRelative(root, path.join(repo, relative))),
			),
		)
		let mapped = 0
		if (triggered.length > 0) {
			for (const dependency of dependencies) {
				if (changed.has(dependency.file)) continue
				if (!owns(dependency.file)) continue
				const fromRoot = rootRelative(root, dependency.file)
				if (triggered.some((rule) => rule.tests(fromRoot))) {
					changed.add(dependency.file)
					mapped++
				}
			}
		}
		log(
			`${changedPaths.length} files changed since ${snapshot.head.slice(0, 12)}, ${uncovered.size} test files not covered by it${viaManifest > 0 ? `, ${viaManifest} test files under a changed manifest` : ''}${viaPackages > 0 ? `, ${viaPackages} test files via installed packages` : ''}${mapped > 0 ? `, ${mapped} test files via dependencies` : ''}`,
		)
		return [...changed]
	}
}

/** Test file → when it was recorded, as Vitest 5.1's resolver lists them; no time for a file without a record. */
async function ownDependencies(
	vitest: Vitest,
	dir: string,
	specifications: ReadonlyArray<TestSpecification>,
): Promise<Array<{ file: string; recordedAt?: number | undefined }>> {
	const records = await readRecords(vitest, dir)
	const { root } = vitest.config
	const recordedAt = new Map<string, number | undefined>()
	for (const specification of specifications) {
		const record =
			records?.projects[specification.project.name]?.files[
				path.relative(root, specification.moduleId).split(path.sep).join('/')
			]
		const file = specification.moduleId
		const previous = recordedAt.get(file)
		if (!record) recordedAt.set(file, undefined)
		else if (!recordedAt.has(file)) recordedAt.set(file, record.at ?? 0)
		else if (previous !== undefined) {
			recordedAt.set(file, Math.min(previous, record.at ?? 0))
		}
	}
	return Array.from(recordedAt, ([file, at]) => ({ file, recordedAt: at }))
}

/**
 * The test files Vitest 5.1 runs for the changed files `selected`: shadow
 * mode's prediction there, and the selection itself on a vitest that has none.
 */
async function affectedTests(
	vitest: Vitest,
	selected: readonly string[],
	records: DependencyRecords | null,
	specifications: ReadonlyArray<TestSpecification>,
	/** Whether a recorded test has to run for the changed files it loaded; they all do without it. */
	needs?: ((test: string, changedDeps: string[]) => boolean) | null,
): Promise<
	{ wouldRun: Set<string>; reason: null } | { wouldRun: 'all'; reason: string }
> {
	const changedFiles = new Set(selected)
	const dependsOnChange = (files: readonly string[] | undefined) =>
		files?.some((file) => changedFiles.has(file)) ?? false
	// What vitest does with the changed files: `forceRerunTriggers` and the
	// root config rerun everything; a project's config, env files, missing
	// record or globalSetup rerun the project; otherwise a test reruns when
	// it has no record or one of its recorded dependencies changed.
	const triggers = vitest.config.forceRerunTriggers
	if (
		selected.some((file) => picomatch.isMatch(file, triggers, { dot: true }))
	) {
		return { wouldRun: 'all', reason: 'a changed file matches forceRerunTriggers' }
	}
	if (dependsOnChange(vitest.vite.config.configFileDependencies)) {
		return { wouldRun: 'all', reason: 'a dependency of the config changed' }
	}
	// The root's globalSetup runs for every project, and is recorded under
	// the root project even when that one has no tests of its own.
	const rootProject = vitest.getRootProject()
	if (
		dependencyStore(vitest) &&
		!vitest.projects.includes(rootProject) &&
		rootProject.config.globalSetup.length > 0
	) {
		const record = records?.projects[rootProject.name]
		const setup = record?.globalSetup?.deps.map((index) =>
			path.resolve(vitest.config.root, record.modules[index] ?? ''),
		)
		if (!setup || dependsOnChange(setup)) {
			return { wouldRun: 'all', reason: 'a dependency of globalSetup changed' }
		}
	}
	const wouldRun = new Set<string>()
	for (const project of vitest.projects) {
		const specs = specifications.filter(
			(specification) => specification.project === project,
		)
		if (specs.length === 0) continue
		const record = records?.projects[project.name]
		// Record paths are relative to the root config's root, whatever the project's.
		const projectRoot = vitest.config.root
		const modules = (indexes: number[] | undefined) =>
			indexes?.map((index) =>
				path.resolve(projectRoot, record?.modules[index] ?? ''),
			)
		if (
			!record ||
			dependsOnChange(project.vite.config.configFileDependencies) ||
			dependsOnChange(envFiles(project)) ||
			(project.config.globalSetup.length > 0 &&
				(!record.globalSetup ||
					dependsOnChange(modules(record.globalSetup.deps))))
		) {
			for (const spec of specs) wouldRun.add(spec.moduleId)
			continue
		}
		for (const spec of specs) {
			const test =
				record.files[
					path.relative(projectRoot, spec.moduleId).split(path.sep).join('/')
				]
			if (!test || changedFiles.has(spec.moduleId)) {
				wouldRun.add(spec.moduleId)
				continue
			}
			const changedDeps = (modules(test.deps) ?? []).filter((file) =>
				changedFiles.has(file),
			)
			if (changedDeps.length === 0 || wouldRun.has(spec.moduleId)) continue
			if (!needs || needs(spec.moduleId, changedDeps)) wouldRun.add(spec.moduleId)
		}
	}
	return { wouldRun, reason: null }
}

function containsOnly(module: TestModule): boolean {
	return (module as { task?: { containsOnly?: boolean } }).task?.containsOnly === true
}

function isPartialSpecification(specification: TestSpecification): boolean {
	// Not every filter exists on every supported vitest.
	const filters = specification as unknown as Record<string, unknown>
	return (
		filters.testLines !== undefined ||
		filters.testIds !== undefined ||
		filters.testNames !== undefined ||
		filters.testNamePattern !== undefined ||
		filters.testTagsFilter !== undefined
	)
}

export interface ShadowResult {
	/** Test files (absolute) the affected selection would have run, `'all'` when it would have run everything, `null` when there was nothing to compare against. */
	wouldRun: Set<string> | 'all' | null
	changed: number
	head: string | null
	key: string | null
	/** Why there is nothing to compare, or why everything would have run. */
	reason: string | null
}

/**
 * Shadow mode: fetches the shard's last record and anchor into a temporary
 * directory while the full run executes, and works out what the affected
 * selection would have run, without touching vitest's `cacheDir` or the run.
 */
export class ShadowAnalysis {
	readonly result: Promise<ShadowResult>

	constructor(
		private readonly vitest: Vitest,
		private readonly dependencies: DependencyRule[],
	) {
		this.result = this.run().catch((error) => ({
			wouldRun: null,
			changed: 0,
			head: null,
			key: null,
			reason: error instanceof Error ? error.message : String(error),
		}))
	}

	private async run(): Promise<ShadowResult> {
		const none = (reason: string): ShadowResult => ({
			wouldRun: null,
			changed: 0,
			head: null,
			key: null,
			reason,
		})
		const base = process.env[ENV_CACHE_URL]
		if (!base) return none(`${ENV_CACHE_URL} is not set`)
		const vitest = this.vitest
		const repo = await repoRoot(vitest.config.root)
		const key = cacheKey({
			snapshotVersion: SNAPSHOT_VERSION,
			runtime: runtimeId(),
			root: repoRelative(repo, vitest.config.root),
			job: jobId(),
			projects: projectNames(vitest),
			shard: vitest.config.shard ?? null,
			head: process.env.GITHUB_SHA || (await headSha(repo)),
		})
		const dir = await mkdtemp(path.join(tmpdir(), 'blacksmith-shadow-'))
		const outcome = await restoreBundle(
			base,
			dir,
			key,
			path.basename(recordsPath(vitest, dir)),
		)
		if (!outcome.restored) return none(outcome.reason)
		const snapshot = await readSnapshot(snapshotPath(vitest, dir))
		const recorded = await recordedDependencies(vitest, dir)
		const records = await readRecords(vitest, dir)
		const { root } = vitest.config
		const owns = await shardOwner(vitest)
		const specifications = (await vitest.globTestSpecifications()).filter(
			(specification) =>
				owns(specification.moduleId, specification.project.name),
		)
		const owned = [
			...new Set(specifications.map((specification) => specification.moduleId)),
		]
		const provider = new TreeSnapshotProvider()
		provider.vitest = vitest
		provider.dependencies = this.dependencies
		let changed = 0
		let lastMessage = ''
		const selected = await provider.select(
			{ root },
			owned.map((file) => ({
				file,
				recordedAt: recorded.has(file) ? 1 : undefined,
			})),
			dir,
			(message) => {
				lastMessage = message
				const match = /^(\d+) files changed/.exec(message)
				if (match) changed = Number(match[1])
			},
		)
		const head = snapshot?.head ?? null
		const all = (reason: string): ShadowResult => ({
			wouldRun: 'all',
			changed,
			head,
			key: outcome.key,
			reason,
		})
		if (selected === null) return all(lastMessage)
		const affected = await affectedTests(
			vitest,
			selected,
			records,
			specifications,
		)
		if (affected.wouldRun === 'all') return all(affected.reason)
		const { wouldRun } = affected
		return { wouldRun, changed, head, key: outcome.key, reason: null }
	}
}

/**
 * Writes the snapshot once a passing run has covered every test the shard owns,
 * so the next `--changed` run can trust the dependency records for all of them.
 */
const RECORDER_BRAND = Symbol.for('blacksmith.snapshotRecorder')

/** True for a `SnapshotRecorder` from any copy of this module (a project's config bundles its own). */
export function isSnapshotRecorder(reporter: unknown): boolean {
	return (
		typeof reporter === 'object' &&
		reporter !== null &&
		RECORDER_BRAND in reporter
	)
}

export class SnapshotRecorder implements Reporter {
	readonly [RECORDER_BRAND] = true
	private vitest!: Vitest
	private started = new Set<string>()
	private partial = false
	/** Tests a run vouches for once its coverage thresholds have passed. */
	private pending: { vouched: string[]; left: string[] } | null = null
	/** Worker records being read into the plugin's own store. */
	private ended: TestModule[] = []

	constructor(
		private readonly provider: TreeSnapshotProvider,
		private readonly options: {
			shadow?: ShadowAnalysis | undefined
		} = {},
	) {}

	/** Shadow mode's verdict for this run, logged once the run has finished. */
	private async reportShadow(
		modules: ReadonlyArray<TestModule>,
	): Promise<void> {
		const shadow = this.options.shadow
		if (!shadow) return
		const log = (message: string) =>
			this.vitest.logger.log(`[blacksmith] shadow: ${message}`)
		const result = await shadow.result
		if (result.wouldRun === null) {
			log(`nothing to compare against (${result.reason ?? 'unknown'})`)
			return
		}
		const ran = this.started
		const would =
			result.wouldRun === 'all'
				? ran
				: new Set([...result.wouldRun].filter((file) => ran.has(file)))
		const since = result.head ? ` since ${result.head.slice(0, 12)}` : ''
		const why =
			result.wouldRun === 'all'
				? `everything: ${result.reason}`
				: `${result.changed} files changed${since}`
		log(
			`would have run ${would.size} of ${ran.size} test files (${why}, from ${result.key ?? 'the cache'})`,
		)
		const failed = modules
			.filter(
				(module) => module.state() === 'failed' || module.errors().length > 0,
			)
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
		const owns = await shardOwner(this.vitest)
		const { deselected } = this.activeProvider()
		// Vitest reports every shard's specifications as started, and the
		// record holds tests of other project sets and deleted files.
		const owned = new Set(
			(await this.vitest.globTestSpecifications())
				.map((specification) => specification.moduleId)
				.filter((file) => owns(file)),
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

	/** The provider vitest is using: the root config's, which may come from another copy of this module. */
	private activeProvider(): {
		deselected: Set<string>
		carried: Map<string, number>
		left: Map<string, number>
	} {
		return configuredProvider(this.vitest) ?? this.provider
	}

	onInit(vitest: Vitest): void {
		this.vitest = vitest
	}

	onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
		this.started = new Set(
			specifications.map((specification) => specification.moduleId),
		)
		this.partial =
			specifications.some(isPartialSpecification) ||
			(this.vitest.config.tagsFilter?.length ?? 0) > 0
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
		await updatePackages(
			this.vitest,
			await repoRoot(this.vitest.config.root),
			this.vitest.vite.config.cacheDir,
			process.env[ENV_RECORD_ROOT],
			cut || modules.some((module) => containsOnly(module)),
			modules
				.filter((module) => module.project.config.browser.enabled)
				.map((module) => module.moduleId),
		)
		if (this.provider.narrow) {
			await updateUnits(
				this.vitest,
				await repoRoot(this.vitest.config.root),
				unitsFile(snapshotPath(this.vitest, this.vitest.vite.config.cacheDir)),
				process.env[ENV_RECORD_ROOT],
				cut || modules.some((module) => containsOnly(module)),
			)
		}
		await this.reportFiltered()
		// A failed run still vouches for the files that passed; the failed ones
		// are left out and rerun next time. An interrupted run left files unrun,
		// an unhandled error fails the run outside any module (`reason` does not
		// see it), and a `.only` skipped its siblings: none of those vouch.
		if (reason === 'interrupted' || errors.length > 0) return
		if (modules.some((module) => containsOnly(module))) return
		const covered = await this.coveredTests(modules)
		if (covered === null) return
		if (covered.left.length > 0) {
			this.vitest.logger.log(
				`[blacksmith] ${covered.left.length} failed test files left out of the dependency snapshot, they run again next time`,
			)
		}
		// Vitest checks coverage thresholds after this hook and fails the run
		// through the exit code alone; the snapshot waits for that verdict. A run
		// already failing hides it, and writes now so its failed tests rerun.
		if (this.checksThresholds(modules) && !failing()) {
			this.pending = covered
			return
		}
		await this.write(covered.vouched, covered.left)
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
		const covered = this.pending
		this.pending = null
		if (covered === null) return
		if (failing()) {
			// An empty snapshot, not none: a fresh checkout would otherwise
			// restore an older one that vouches for these tests.
			this.vitest.logger.log(
				'[blacksmith] coverage thresholds failed, the dependency snapshot vouches for no test and the next run runs them all',
			)
			await this.write([], [...covered.vouched, ...covered.left])
			return
		}
		await this.write(covered.vouched, covered.left)
	}

	private async write(
		vouched: readonly string[],
		left: readonly string[],
	): Promise<void> {
		const cacheDir = this.vitest.vite.config.cacheDir
		const { root, shard } = this.vitest.config
		const repo = await repoRoot(root)
		await pruneRecords(this.vitest, repo, cacheDir)
		const snapshot: Snapshot = {
			version: SNAPSHOT_VERSION,
			runtime: runtimeId(),
			head: await headSha(repo),
			at: Date.now(),
			root: repoRelative(repo, root),
			shard: shard ?? null,
			job: jobId(),
			projects: projectNames(this.vitest),
			tree: await currentTree(
				this.vitest,
				repo,
				cacheDir,
				this.provider.dependencies,
			),
			tests: [],
			times: {},
			left: {},
		}
		// Other shards' test files first: this run's own result replaces theirs.
		const now = snapshot.at
		for (const [test, time] of [
			...this.activeProvider().carried,
			...vouched.map((test) => [test, now] as const),
		]) {
			// One deleted since, or moved out of the repository's test files.
			if (!existsSync(test)) continue
			snapshot.times[repoRelative(repo, test)] = time
		}
		for (const [test, time] of [
			...this.activeProvider().left,
			...left.map((test) => [test, now] as const),
		]) {
			const relative = repoRelative(repo, test)
			if (existsSync(test) && !Object.hasOwn(snapshot.times, relative)) {
				snapshot.left[relative] = time
			}
		}
		snapshot.tests = Object.keys(snapshot.times).sort()
		for (const [test, time] of Object.entries(snapshot.times)) {
			if (time === now) delete snapshot.times[test]
		}
		const file = snapshotPath(this.vitest, cacheDir)
		await mkdir(path.dirname(file), { recursive: true })
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
		await writeFile(tmp, JSON.stringify(snapshot))
		await rename(tmp, file)
		if (this.provider.narrow) await advanceDigests(repo, unitsFile(file))
		await this.publish(snapshot)
	}

	/** Puts the record and this anchor in the Actions cache when a run can reach it. */
	private async publish(snapshot: Snapshot): Promise<void> {
		const base = process.env[ENV_CACHE_URL]
		if (!base) return
		const key = cacheKey({
			snapshotVersion: snapshot.version,
			runtime: snapshot.runtime,
			root: snapshot.root,
			job: snapshot.job,
			projects: snapshot.projects,
			shard: snapshot.shard,
			head: snapshot.head,
		})
		try {
			const outcome = await saveBundle(
				base,
				this.vitest.vite.config.cacheDir,
				key,
				path.basename(
					recordsPath(this.vitest, this.vitest.vite.config.cacheDir),
				),
			)
			this.vitest.logger.log(
				outcome.saved
					? `[blacksmith] saved dependency cache ${key.key} (${outcome.bytes} bytes)`
					: `[blacksmith] dependency cache not saved: ${outcome.reason}`,
			)
		} catch (error) {
			this.vitest.logger.log(
				`[blacksmith] dependency cache not saved: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * The tests this shard owns, split into those the run vouches for (passed,
	 * or deselected by our own provider) and those `left` out (failed, or never
	 * reached); `null` when the run covered less than the shard.
	 */
	private async coveredTests(
		modules: ReadonlyArray<TestModule>,
	): Promise<{ vouched: string[]; left: string[] } | null> {
		if (this.partial || this.vitest.getGlobalTestNamePattern() !== undefined) {
			return null
		}
		const owns = await shardOwner(this.vitest)
		const { deselected } = this.activeProvider()
		const owned = [
			...new Set(
				(await this.vitest.globTestSpecifications())
					.map((specification) => specification.moduleId)
					.filter((file) => owns(file)),
			),
		]
		// Nothing owned (an `include` matching no file) vouches for nothing.
		if (owned.length === 0) return null
		if (!owned.every((file) => this.started.has(file) || deselected.has(file)))
			return null
		// A file may run in several projects; it passed when every one did.
		const passed = new Map<string, boolean>()
		for (const module of modules) {
			const state = module.state()
			const fine =
				(state === 'passed' || state === 'skipped') &&
				module.errors().length === 0
			passed.set(module.moduleId, (passed.get(module.moduleId) ?? true) && fine)
		}
		const vouched: string[] = []
		const left: string[] = []
		// Vitest reruns a deselected file when its config or globalSetup changed;
		// one that ran is judged by its result, deselection vouches only for
		// files that did not run.
		for (const file of owned) {
			const fine = this.started.has(file)
				? passed.get(file) === true
				: deselected.has(file)
			;(fine ? vouched : left).push(file)
		}
		return { vouched, left }
	}
}

/**
 * Before selection: when the Actions cache is reachable and Vitest's cache
 * directory (`cacheDir`, wherever the config puts it) holds no record yet,
 * pulls the newest record for this shard and project set into it. The
 * directory itself may exist: every `vitest run` on one config shares it
 * (its hash is the root `test.name`, not the `--project` filter).
 */
export async function restoreDependencyCache(
	vitest: Vitest,
	maxShards = DEFAULT_MAX_SHARDS,
): Promise<void> {
	const base = process.env[ENV_CACHE_URL]
	if (!base) {
		if (process.env.TURBO_HASH)
			vitest.logger.warn(
				`[blacksmith] running under turbo, which hides ${ENV_CACHE_URL} in strict env mode; add it to passThroughEnv to use the dependency cache`,
			)
		return
	}
	// Only this run's own anchor blocks a restore: every `vitest run` on one config
	// shares `cacheDir`, so another project set's anchor may already be there.
	const anchor = snapshotPath(vitest, vitest.vite.config.cacheDir)
	if (existsSync(anchor)) {
		vitest.logger.warn(
			`[blacksmith] ${path.relative(vitest.config.root, anchor)} already exists, not restoring the dependency cache over it`,
		)
		return
	}
	const repo = await repoRoot(vitest.config.root)
	const head = process.env.GITHUB_SHA || (await headSha(repo))
	const keyOf = (index: number) =>
		cacheKey({
			snapshotVersion: SNAPSHOT_VERSION,
			runtime: runtimeId(),
			root: repoRelative(repo, vitest.config.root),
			job: jobId(),
			projects: projectNames(vitest),
			shard: { index },
			head,
		})
	if (!cacheMode().readable) {
		vitest.logger.log(
			'[blacksmith] no dependency cache: the Actions cache is not readable for this job',
		)
		return
	}
	const cacheDir = vitest.vite.config.cacheDir
	const records = path.basename(recordsPath(vitest, cacheDir))
	// An unsharded run is number 0: it saves beside shard 1, not in its place.
	const own = vitest.config.shard?.index ?? 0
	let failure: string | null = null
	// Every shard's entry, whatever count they were saved under: a test file
	// that another shard ran last has its record there.
	const fetched = await pooled(
		Array.from({ length: Math.max(maxShards, own) + 1 }, (_, at) => at),
		RESTORES_AT_ONCE,
		async (index) => {
			const dir = await mkdtemp(path.join(tmpdir(), 'blacksmith-entry-'))
			try {
				const outcome = await restoreBundle(base, dir, keyOf(index), records)
				if (outcome.restored) {
					const snapshot = await adoptSnapshot(vitest, dir, index)
					if (snapshot) return { index, dir, key: outcome.key, ...snapshot }
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error)
			}
			await rm(dir, { recursive: true, force: true })
			return null
		},
	)
	const found = fetched
		.filter((entry) => entry !== null)
		.sort(
			(a, b) =>
				Number(b.index === own) - Number(a.index === own) ||
				b.snapshot.at - a.snapshot.at,
		)
	if (found.length === 0) {
		vitest.logger.log(
			failure === null
				? `[blacksmith] no dependency cache: no entry under ${keyOf(own).prefix}`
				: `[blacksmith] dependency cache not restored: ${failure}`,
		)
		return
	}
	const owns = await shardOwner(vitest)
	// Each test file from the entry that ran it last; on a tie the shard's
	// own entry, which comes first.
	const latest = new Map<string, { time: number; from: number }>()
	found.forEach(({ snapshot }, from) => {
		for (const test of snapshot.tests) {
			const time = snapshot.times[test] ?? snapshot.at
			const known = latest.get(test)
			if (known === undefined || time > known.time) latest.set(test, { time, from })
		}
	})
	// A test file left out since then: no entry is used for it.
	for (const { snapshot } of found) {
		for (const [test, time] of Object.entries(snapshot.left)) {
			const known = latest.get(test)
			if (known === undefined || time >= known.time) {
				latest.set(test, { time, from: -1 })
			}
		}
	}
	const left = new Map<string, number>()
	const entries: CacheEntry[] = found.map(({ dir, key }) => ({
		dir,
		key,
		tests: new Set<string>(),
		others: new Map<string, number>(),
	}))
	for (const [test, { time, from }] of latest) {
		const file = path.join(repo, test)
		const entry = entries[from]
		if (entry === undefined) {
			if (!owns(file)) left.set(file, time)
			continue
		}
		if (owns(file)) (entry.tests as Set<string>).add(file)
		else (entry.others as Map<string, number>).set(file, time)
	}
	const used = entries.filter((entry) => entry.tests.size + entry.others.size > 0)
	await mkdir(cacheDir, { recursive: true })
	const mine = found[0]
	// The shard's own entry, saved under this count, vouching for its test
	// files alone and for all of them: the run goes on from it as it is.
	if (
		mine !== undefined &&
		mine.index === own &&
		sameShard(mine.saved, vitest.config.shard) &&
		used.every((entry) => entry.dir === mine.dir && entry.others.size === 0) &&
		left.size === 0
	) {
		await cp(mine.dir, cacheDir, { recursive: true })
		vitest.logger.log(`[blacksmith] restored dependency cache ${mine.key}`)
		return
	}
	restoredOf.set(vitest, { entries: used, left })
	if (used.length === 0) {
		vitest.logger.log(
			`[blacksmith] no dependency cache: no entry holds a test file of the ${describeShard(vitest.config.shard)}`,
		)
		return
	}
	const { root } = vitest.config
	await mergeRecords(
		used.map((entry) => {
			const tests = [...entry.tests, ...entry.others.keys()]
			return {
				records: recordsPath(vitest, entry.dir),
				dir: entry.dir,
				units: unitsFile(snapshotPath(vitest, entry.dir)),
				fromRoot: new Set(tests.map((file) => rootRelative(root, file))),
				fromRepo: new Set(tests.map((file) => repoRelative(repo, file))),
			}
		}),
		{
			records: recordsPath(vitest, cacheDir),
			dir: cacheDir,
			units: unitsFile(snapshotPath(vitest, cacheDir)),
		},
	)
	for (const entry of used) {
		if (entry.tests.size === 0) continue
		vitest.logger.log(
			`[blacksmith] restored dependency cache ${entry.key} for ${entry.tests.size} test files`,
		)
	}
}

/** What `maxShards` is when the plugin's options leave it out. */
export const DEFAULT_MAX_SHARDS = 20
const RESTORES_AT_ONCE = 20

/** One restored cache entry in a directory of its own, and the test files (absolute) the run takes from it. */
interface CacheEntry {
	dir: string
	key: string
	tests: ReadonlySet<string>
	/** Test files of other shards it vouches for, and when each last ran. */
	others: ReadonlyMap<string, number>
}

// On the process: a project with its own root evaluates the config, and so
// the plugin, a second time.
const RESTORED = Symbol.for('blacksmith.vitest.restoredEntries')
/** What a run restored: the entries it selects from, and the other shards' test files that were left out. */
const restoredOf = ((globalThis as unknown as {
	[RESTORED]?: WeakMap<
		Vitest,
		{ entries: CacheEntry[]; left: ReadonlyMap<string, number> }
	>
})[RESTORED] ??= new WeakMap())

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

const SNAPSHOT_NAME = /^blacksmith(\.[0-9a-f]{12})?(\.\d+of\d+)?\.json$/

/**
 * Makes the anchor an entry was saved with, and its function record, the
 * ones this run reads in `dir`: another shard, or this one on another count,
 * named them after itself. `saved` is the shard that wrote it, number `index`.
 */
async function adoptSnapshot(
	vitest: Vitest,
	dir: string,
	index: number,
): Promise<{ snapshot: Snapshot; saved: Shard | null } | null> {
	// A bundle carries the anchors of every run that shared the cache
	// directory; the entry is the one of the shard it is named after.
	let theirs: string | undefined
	let snapshot: Snapshot | null = null
	// Its name without the shard: an anchor of another `--project` set that
	// shared the cache directory is not this run's.
	const stem = path
		.basename(snapshotPath(vitest, dir), '.json')
		.replace(/\.\d+of\d+$/, '')
	for (const name of await readdir(dir)) {
		if (!SNAPSHOT_NAME.test(name)) continue
		const file = path.join(dir, name)
		if (name.replace(/(\.\d+of\d+)?\.json$/, '') !== stem) {
			await rm(unitsFile(file), { force: true })
			await rm(file)
			continue
		}
		const candidate: Snapshot | null =
			snapshot === null ? await readSnapshot(file) : null
		if (candidate !== null && (candidate.shard?.index ?? 0) === index) {
			theirs = file
			snapshot = candidate
			continue
		}
		await rm(unitsFile(file), { force: true })
		await rm(file)
	}
	if (theirs === undefined || snapshot === null) return null
	const saved = snapshot.shard
	const ours = snapshotPath(vitest, dir)
	if (theirs !== ours) {
		if (existsSync(unitsFile(theirs))) {
			await rename(unitsFile(theirs), unitsFile(ours))
		}
		await rm(theirs)
	}
	snapshot.shard = vitest.config.shard ?? null
	await writeFile(ours, JSON.stringify(snapshot))
	return { snapshot, saved }
}
