import path from 'node:path'

import picomatch from 'picomatch'

import { isPackagePath } from './packages.ts'
import {
	RECORDS_VERSION,
	emptyRecords,
	specPath,
	specProject,
	type FileRecord,
	type Records,
	type RunRecord,
	type TestRecord,
} from './record.ts'

/**
 * The rules that read the record: which test files a change reruns, and what
 * a run leaves of the record it started from. Every plugin decides with
 * these, so a rule added here holds for all of them.
 */

/** The options every plugin takes. */
export interface Options {
	/** Test file glob → globs of files those test files depend on that nothing reads. */
	dependencies?: Readonly<Record<string, string | readonly string[]>>
	/** `host:port` a test talks to → globs of the files that define what answers there. */
	services?: Readonly<Record<string, string | readonly string[]>>
	/**
	 * The largest shard count accepted, 20 by default; a run split further
	 * fails. Each shard looks in the Actions cache for the record of every
	 * shard up to this number.
	 */
	maxShards?: number
}

const list = (value: string | readonly string[] | undefined): string[] =>
	value === undefined ? [] : typeof value === 'string' ? [value] : [...value]

/** A `dependencies` entry, compiled: test files matching `tests` depend on files matching `deps`; both take repository-relative paths. */
export interface Rule {
	/** The test file glob as written, for messages. */
	source: string
	tests: (file: string) => boolean
	deps: (file: string) => boolean
	/** Repository-relative directories the `deps` globs start in (`fixtures` for `fixtures/**`), where git-ignored files are looked for; a glob with no fixed start has none. */
	bases: string[]
}

/**
 * A glob written as a path from `base` (`../../packages/*\/package.json`
 * from `packages/a`) in the form the candidates take, `../*\/package.json`:
 * `path.relative` folds the `..` segments the same way for both.
 */
function normalizeGlob(glob: string, base: string, repo: string | undefined): string {
	if (!/^\.\.?\//.test(glob)) return glob
	if (repo === undefined) return path.posix.normalize(glob)
	const from = path.join(repo, base)
	return path.relative(from, path.resolve(from, glob)).split(path.sep).join('/')
}

/** A matcher of repository-relative paths for globs written relative to `base`, a repository-relative directory ('' for the root). */
function matcher(globs: string[], base: string): (file: string) => boolean {
	if (globs.length === 0) return () => false
	const matches = picomatch(globs, { dot: true })
	return base === ''
		? (file) => matches(file)
		: (file) => matches(path.posix.relative(base, file))
}

function inRepository(file: string): boolean {
	return file !== '' && file !== '..' && !file.startsWith('../') && !path.posix.isAbsolute(file)
}

/** What the rule options name, compiled once per run. `base` is the repository-relative directory their globs are relative to. */
export interface Rules {
	dependencies: Rule[]
	/** `host:port` → the files that define what answers there. */
	services: Map<string, (file: string) => boolean>
	/** Whether some rule names the file as something to depend on: nothing reads these, so only the anchor sees them change. */
	names: (file: string) => boolean
}

/** `repo` is the repository's directory, for a glob that leaves `base` through `..` and comes back by name. */
export function compileRules(options: Options, base = '', repo?: string): Rules {
	const normal = (globs: string[]): string[] =>
		globs.map((glob) => normalizeGlob(glob, base, repo))
	const dependencies = Object.entries(options.dependencies ?? {}).map(
		([tests, deps]): Rule => {
			const globs = normal(list(deps))
			return {
				source: tests,
				tests: matcher(normal([tests]), base),
				deps: matcher(globs, base),
				bases: globs
					.map((glob) => picomatch.scan(glob).base)
					.filter((start) => start !== '' && start !== '.')
					.map((start) => path.posix.normalize(path.posix.join(base, start)))
					.filter(inRepository),
			}
		},
	)
	const services = new Map(
		Object.entries(options.services ?? {}).map(([endpoint, globs]) => [
			endpoint,
			matcher(normal(list(globs)), base),
		]),
	)
	return {
		dependencies,
		services,
		names: (file) =>
			dependencies.some((rule) => rule.deps(file)) ||
			[...services.values()].some((matches) => matches(file)),
	}
}

/** Whether the change to `file`, which the test file `spec` loaded, can alter what `spec` does. */
export type Affects = (spec: string, file: string) => boolean

export interface Policy {
	rules?: Rules
	/** Looks inside a changed file a test file loaded; without it every change to one reruns the test file. */
	affects?: Affects | undefined
}

export interface TestReason {
	title: string
	reason: string
	/** Something the test's record names changed: the record no longer holds. */
	stale?: true
}

export type Decision =
	| { run: false }
	| {
			run: true
			reason: string
			/** Something the file's record names changed: the record no longer holds for any of its tests. */
			stale?: true
			/** The tests the reason is about, when the rest of the file has nothing to run for. */
			tests?: TestReason[]
	  }

export const LOCKFILES: ReadonlySet<string> = new Set([
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
export function isManifest(file: string): boolean {
	const base = path.posix.basename(file)
	return base === 'package.json' || /^tsconfig(\..+)?\.json$/.test(base)
}

/** The directory of a repository-relative file, '' for the root. */
export function repoDir(file: string): string {
	const dir = path.posix.dirname(file)
	return dir === '.' ? '' : dir
}

/** Every file reachable from `roots` over `graph`, the roots included. */
export function closure(
	graph: Record<string, string[]>,
	roots: Iterable<string>,
): Set<string> {
	const seen = new Set<string>()
	const queue = [...roots]
	while (queue.length > 0) {
		const file = queue.pop()
		if (file === undefined || seen.has(file)) continue
		seen.add(file)
		for (const next of graph[file] ?? []) queue.push(next)
	}
	return seen
}

const NO_RULES: Rules = { dependencies: [], services: new Map(), names: () => false }

/**
 * Decides, per test file, whether it runs. A file is skipped only when it
 * has a record, nothing that record names changed, and every test in it has
 * a record of its own that is not a failure. In order:
 *
 * 1. no record: the file never ran, or what changed took its record;
 * 2. a changed file it depends on as a whole: itself, what every test file
 *    or every one of its project depends on, what it loaded (`affects` may find the change out of its
 *    reach), or what a `dependencies` or `services` rule maps to it;
 * 3. a changed manifest above it or above something it loaded;
 * 4. a changed lockfile, when its list of packages is known to miss some;
 * 5. it failed outside any test;
 * 6. a test in it never ran, failed, or read a file that changed.
 */
export function select(
	records: Records,
	specs: readonly string[],
	changed: readonly string[],
	policy: Policy = {},
): Record<string, Decision> {
	const rules = policy.rules ?? NO_RULES
	const result: Record<string, Decision> = {}
	const graphed = Object.keys(records.graph).length > 0
	const reach = (roots: Iterable<string>): Set<string> =>
		graphed ? closure(records.graph, roots) : new Set(roots)
	const global = reach(records.global)
	const manifests = changed.filter(isManifest).map((file) => ({
		file,
		dir: repoDir(file),
	}))
	const under = (file: string, dir: string): boolean =>
		inRepository(file) && (dir === '' || file.startsWith(`${dir}/`))
	const lockfile = changed.find((file) => LOCKFILES.has(path.posix.basename(file)))
	for (const spec of specs) {
		const entry = records.files[spec]
		if (!entry) {
			result[spec] = { run: true, reason: 'no record' }
			continue
		}
		const own = specPath(spec)
		const deps = reach([own, ...entry.deps, ...(records.projects[specProject(spec) ?? ''] ?? [])])
		const mapped = rules.dependencies.filter((rule) => rule.tests(own))
		const endpoints = new Set(entry.endpoints)
		for (const test of Object.values(entry.tests)) {
			for (const endpoint of test.endpoints ?? []) endpoints.add(endpoint)
		}
		const served = [...endpoints].flatMap((endpoint) => rules.services.get(endpoint) ?? [])
		let hit = changed.find((file) => {
			if (mapped.some((rule) => rule.deps(file))) return true
			if (served.some((matches) => matches(file))) return true
			if (global.has(file)) return true
			if (!deps.has(file)) return false
			return file === own || !policy.affects || policy.affects(spec, file)
		})
		// Through the import graph too: a runner that records only what a test file imports directly names the rest there.
		hit ??= manifests.find(({ dir }) => [...deps].some((file) => under(file, dir)))?.file
		if (hit === undefined && entry.incomplete) hit = lockfile
		if (hit !== undefined) {
			result[spec] = { run: true, reason: `changed: ${hit}`, stale: true }
			continue
		}
		if (entry.failed) {
			result[spec] = { run: true, reason: 'failed last time' }
			continue
		}
		const tests: TestReason[] = []
		for (const title of entry.all ?? Object.keys(entry.tests)) {
			const test = entry.tests[title]
			if (!test) tests.push({ title, reason: 'never ran' })
			else if (test.state === 'failed') tests.push({ title, reason: 'failed last time' })
			else if (test.deps && test.deps.length > 0) {
				const read = reach(test.deps)
				const dep =
					changed.find((file) => read.has(file)) ??
					manifests.find(({ dir }) => [...read].some((file) => under(file, dir)))?.file
				if (dep !== undefined) tests.push({ title, reason: `changed: ${dep}`, stale: true })
			}
		}
		const first = tests[0]
		result[spec] = first ? { run: true, reason: first.reason, tests } : { run: false }
	}
	return result
}

const union = (a: readonly string[] | undefined, b: readonly string[] | undefined): string[] =>
	[...new Set([...(a ?? []), ...(b ?? [])])].sort()

/** `stored` without what `changed` invalidates: a test file whose dependencies changed loses its record, a test whose own reads changed loses its own. */
export function dropStale(
	stored: Records | null,
	changed: readonly string[],
	policy: Policy = {},
): Records {
	const out =
		stored?.version === RECORDS_VERSION ? structuredClone(stored) : emptyRecords()
	const verdict = select(out, Object.keys(out.files), changed, policy)
	for (const [spec, decision] of Object.entries(verdict)) {
		if (!decision.run) continue
		if (decision.stale) delete out.files[spec]
		for (const test of decision.tests ?? []) {
			if (test.stale) delete out.files[spec]?.tests[test.title]
		}
	}
	// The run that loads a changed file records what it imports again.
	for (const file of changed) delete out.graph[file]
	return out
}

/**
 * Merges what one or more runs recorded into the stored record. `changed` is
 * what the anchor diff reported before those runs started. Several runs are
 * the shards of one CI run, each of which ran part of the tests against the
 * same stored record.
 *
 * 1. Whatever `changed` invalidates is dropped first (`dropStale`). A test
 *    file or test that then did not run (a filter, another shard, a bail)
 *    is left without a record and runs next time.
 * 2. The graph is unioned, never replaced: an import inside a function only
 *    produces its edge in the run that calls it.
 * 3. A test file that ran in full replaces its record. One that ran in part
 *    adds to it: the tests that ran replace theirs, the dependencies are
 *    unioned, and when nothing says which tests were left out and no record
 *    was there to add to, the file is marked failed, since those tests
 *    never ran against the current files.
 */
export function mergeRecords(
	stored: Records | null,
	runs: readonly RunRecord[],
	changed: readonly string[],
	policy: Policy = {},
): Records {
	const out = dropStale(stored, changed, policy)
	for (const run of runs) {
		for (const [from, to] of Object.entries(run.graph ?? {})) {
			out.graph[from] = union(out.graph[from], to)
		}
		// A run of a project loads its config and setup anew.
		for (const [project, files] of Object.entries(run.projects ?? {})) {
			out.projects[project] = [...files].sort()
		}
		// A run of every recorded test file saw everything `global` can hold;
		// a run of some of them did not load what only the others make the
		// runner look up, so what the record already names stays.
		const all = Object.keys(out.files).every((spec) => spec in run.files)
		if (Object.keys(run.files).length > 0) {
			// Packages stay either way: with a warm transform cache a runner
			// does not load the transformer's packages, and a later run would.
			out.global = all
				? union(out.global.filter(isPackagePath), run.global)
				: union(out.global, run.global)
		}
		for (const [spec, { partial, ...entry }] of Object.entries(run.files)) {
			const previous = out.files[spec]
			const titles = entry.all
			const complete =
				!partial && (titles === undefined || titles.every((title) => entry.tests[title]))
			if (complete) {
				out.files[spec] = { ...entry, at: run.at }
				continue
			}
			const tests: Record<string, TestRecord> = {}
			// A failure outside the tests leaves the ones under it unrun: nothing vouches for them.
			if (previous && !entry.failed) {
				for (const [title, test] of Object.entries(previous.tests)) {
					if (!titles || titles.includes(title)) tests[title] = test
				}
			}
			Object.assign(tests, entry.tests)
			const merged: FileRecord = {
				deps: union(previous?.deps, entry.deps),
				tests,
				at: run.at,
			}
			const all = titles ?? previous?.all
			if (all) merged.all = all
			if (previous?.endpoints || entry.endpoints) {
				merged.endpoints = union(previous?.endpoints, entry.endpoints)
			}
			if (previous?.manifests || entry.manifests) {
				merged.manifests = union(previous?.manifests, entry.manifests)
			}
			if (entry.failed || (previous ? previous.failed : titles === undefined)) {
				merged.failed = true
			}
			if (entry.incomplete || previous?.incomplete) merged.incomplete = true
			out.files[spec] = merged
		}
		out.at = Math.max(out.at, run.at)
	}
	return out
}
