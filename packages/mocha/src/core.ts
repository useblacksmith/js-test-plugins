import { readFileSync } from 'node:fs'
import path from 'node:path'

import picomatch from 'picomatch'

/**
 * The dependency record and the rules that read it. Mocha loads every spec
 * file into one process, so there is no module graph per file: the record
 * keeps one import graph for the run and derives a spec's dependencies as
 * its closure, plus what each of its tests read while it ran.
 */
export const RECORDS_VERSION = 4

export interface TestRecord {
	state: 'passed' | 'failed' | 'pending'
	/** Files the test read, or modules it loaded, while it ran. */
	deps: string[]
	/** `host:port` of every socket the test wrote to. */
	endpoints: string[]
}

export interface SpecRecord {
	/** Full title of every test in the file, known on every run: Mocha loads the whole file whatever `--grep` says. */
	all: string[]
	/** Files the file's `before`/`after` hooks read. */
	hooks: string[]
	hookEndpoints: string[]
	tests: Record<string, TestRecord>
	/** A suite hook failed, so tests under it never ran. */
	hookFailed?: boolean
	at?: number
}

/** What one Mocha run recorded. Paths are repository-relative with `/`. */
export interface RunRecord {
	at: number
	/** importer → imported, and module → file it read while loading or on behalf of a test. */
	graph: Record<string, string[]>
	/** Files every spec depends on: what `--require` loaded and what packages read on no test's behalf. */
	global: string[]
	files: Record<string, SpecRecord>
}

export interface Records extends RunRecord {
	version: number
}

type StoredTest = Omit<TestRecord, 'deps'> & { deps: number[] }
type StoredSpec = Omit<SpecRecord, 'hooks' | 'tests'> & {
	hooks: number[]
	tests: Record<string, StoredTest>
}

/**
 * The record as the file holds it: each path once, and the graph, `global`,
 * `hooks` and `deps` as positions in `paths`. A module is named once for
 * every module that imports it, so naming it in full each time made the
 * file several times larger.
 */
export interface StoredRecords {
	version: number
	at: number
	paths: string[]
	/** `[importer, ...imported]`, each a position. */
	graph: number[][]
	global: number[]
	files: Record<string, StoredSpec>
}

export function storeRecords(records: Records): StoredRecords {
	const at = new Map<string, number>()
	const paths: string[] = []
	const position = (file: string): number => {
		let found = at.get(file)
		if (found === undefined) {
			found = paths.length
			at.set(file, found)
			paths.push(file)
		}
		return found
	}
	const files: StoredRecords['files'] = {}
	for (const [spec, entry] of Object.entries(records.files)) {
		const tests: StoredSpec['tests'] = {}
		for (const [title, test] of Object.entries(entry.tests)) {
			tests[title] = { ...test, deps: test.deps.map(position) }
		}
		files[spec] = { ...entry, hooks: entry.hooks.map(position), tests }
	}
	return {
		version: RECORDS_VERSION,
		at: records.at,
		paths,
		graph: Object.entries(records.graph).map(([from, to]) => [
			position(from),
			...to.map(position),
		]),
		global: records.global.map(position),
		files,
	}
}

/** The record a file holds, or null when it is not one this version reads. */
export function loadRecords(stored: StoredRecords | Records | null): Records | null {
	if (stored === null || typeof stored !== 'object') return null
	// The layout before this one named the paths wherever they were used.
	if (stored.version === 3 && !('paths' in stored)) {
		return { ...stored, version: RECORDS_VERSION }
	}
	if (stored.version !== RECORDS_VERSION || !('paths' in stored)) return null
	try {
		const name = (position: number): string => {
			const file = stored.paths[position]
			if (typeof file !== 'string') throw new Error('not a record')
			return file
		}
		const graph: Records['graph'] = {}
		for (const [from, ...to] of stored.graph) {
			if (from === undefined) throw new Error('not a record')
			graph[name(from)] = to.map(name)
		}
		const files: Records['files'] = {}
		for (const [spec, entry] of Object.entries(stored.files)) {
			const tests: SpecRecord['tests'] = {}
			for (const [title, test] of Object.entries(entry.tests)) {
				tests[title] = { ...test, deps: test.deps.map(name) }
			}
			files[spec] = { ...entry, hooks: entry.hooks.map(name), tests }
		}
		return {
			version: RECORDS_VERSION,
			at: stored.at,
			graph,
			global: stored.global.map(name),
			files,
		}
	} catch {
		return null
	}
}

export interface Options {
	/** Spec glob → globs of files those specs depend on that nothing reads. */
	dependencies?: Record<string, string | string[]>
	/** `host:port` a test talks to → globs of the files that define what answers there. */
	services?: Record<string, string | string[]>
}

export interface TestReason {
	title: string
	reason: string
}

export type Decision =
	| { run: false }
	| { run: true; reason: string; tests?: TestReason[] }

export function emptyRecords(): Records {
	return { version: RECORDS_VERSION, at: 0, graph: {}, global: [], files: {} }
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

const list = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : [value].flat()

/** Every glob the `dependencies` and `services` options name. */
export function ruleGlobs(options: Options): string[] {
	return [
		...Object.values(options.dependencies ?? {}),
		...Object.values(options.services ?? {}),
	].flatMap(list)
}

interface SpecDependencies {
	/** The import closure of the spec, the global files and its hooks' reads: a change reruns every test. */
	base: Set<string>
	perTest: Map<string, Set<string>>
	matches: (file: string) => boolean
}

function specDependencies(
	records: Records,
	spec: string,
	options: Options,
): SpecDependencies {
	const entry = records.files[spec]
	const base = closure(records.graph, [
		spec,
		...records.global,
		...(entry?.hooks ?? []),
	])
	const globs: string[] = []
	for (const [tests, deps] of Object.entries(options.dependencies ?? {})) {
		if (picomatch.isMatch(spec, tests, { dot: true })) globs.push(...list(deps))
	}
	const perTest = new Map<string, Set<string>>()
	const endpoints = new Set(entry?.hookEndpoints ?? [])
	for (const [title, test] of Object.entries(entry?.tests ?? {})) {
		perTest.set(title, closure(records.graph, test.deps))
		for (const endpoint of test.endpoints) endpoints.add(endpoint)
	}
	for (const endpoint of endpoints) {
		globs.push(...list(options.services?.[endpoint]))
	}
	const matcher =
		globs.length > 0 ? picomatch(globs, { dot: true }) : () => false
	return { base, perTest, matches: (file) => matcher(file) }
}

/**
 * Decides, per spec file, whether it runs. A spec is skipped only when every
 * test in it has a record that is not failed and nothing those records name
 * changed: a test `--grep` left out has no record, so its file stays affected.
 */
export function select(
	records: Records,
	specs: string[],
	changed: string[],
	options: Options = {},
): Record<string, Decision> {
	const result: Record<string, Decision> = {}
	for (const spec of specs) {
		const entry = records.files[spec]
		if (!entry) {
			result[spec] = { run: true, reason: 'no record' }
			continue
		}
		const deps = specDependencies(records, spec, options)
		const hit = changed.find((file) => deps.base.has(file) || deps.matches(file))
		if (hit !== undefined) {
			result[spec] = { run: true, reason: `changed: ${hit}` }
			continue
		}
		const tests: TestReason[] = []
		for (const title of entry.all) {
			const test = entry.tests[title]
			if (!test) tests.push({ title, reason: 'never ran' })
			else if (test.state === 'failed')
				tests.push({ title, reason: 'failed last time' })
			else {
				const dep = changed.find((file) => deps.perTest.get(title)?.has(file))
				if (dep !== undefined) tests.push({ title, reason: `changed: ${dep}` })
			}
		}
		const first = tests[0]
		result[spec] = first
			? { run: true, reason: first.reason, tests }
			: { run: false }
	}
	return result
}

const union = (a: string[] | undefined, b: string[]): string[] =>
	[...new Set([...(a ?? []), ...b])].sort()

/**
 * Merges what one or more runs recorded into the stored record. `changed` is
 * what the anchor diff reported before those runs started.
 *
 * 1. Whatever `changed` invalidates is dropped first: a spec whose import
 *    closure changed loses every test record, a test whose own reads changed
 *    loses its own. A test that then did not run (`--grep`, another shard,
 *    `--bail`) is left without a record and runs next time.
 * 2. The graph is unioned, never replaced: a `require()` inside a function
 *    only produces its edge in the run that calls it. Edges out of a changed
 *    file are dropped, since the run that loaded it recorded them again.
 * 3. A test that ran replaces its record; one that did not keeps the record
 *    step 1 left it. Several runs are the shards of one CI run, each of
 *    which ran part of the tests against the same stored record.
 */
export function mergeRecords(
	stored: Records | null,
	runs: RunRecord[],
	changed: string[],
	options: Options = {},
): Records {
	const out =
		stored?.version === RECORDS_VERSION
			? structuredClone(stored)
			: emptyRecords()
	const verdict = select(out, Object.keys(out.files), changed, options)
	for (const [spec, decision] of Object.entries(verdict)) {
		if (!decision.run) continue
		if (!decision.tests) delete out.files[spec]
		else {
			for (const test of decision.tests) {
				if (test.reason.startsWith('changed')) {
					delete out.files[spec]?.tests[test.title]
				}
			}
		}
	}
	for (const file of changed) delete out.graph[file]
	for (const run of runs) {
		for (const [from, to] of Object.entries(run.graph)) {
			out.graph[from] = union(out.graph[from], to)
		}
		if (Object.keys(run.files).length > 0) out.global = [...run.global].sort()
		for (const [spec, entry] of Object.entries(run.files)) {
			const previous = out.files[spec]
			const tests: Record<string, TestRecord> = {}
			for (const title of entry.all) {
				const now = entry.tests[title]
				const before = previous?.tests[title]
				if (now) tests[title] = now
				// A failed suite hook leaves the tests under it unrun: nothing vouches for them.
				else if (before && !entry.hookFailed) tests[title] = before
			}
			out.files[spec] = {
				at: run.at,
				all: entry.all,
				hooks: union(previous?.hooks, entry.hooks),
				hookEndpoints: union(previous?.hookEndpoints, entry.hookEndpoints),
				tests,
			}
		}
		out.at = Math.max(out.at, run.at)
	}
	return out
}

/** Every repository path the record names: what the anchor has to cover. */
export function recordedPaths(records: Records): Set<string> {
	const paths = new Set<string>(records.global)
	for (const [from, to] of Object.entries(records.graph)) {
		paths.add(from)
		for (const file of to) paths.add(file)
	}
	for (const [spec, entry] of Object.entries(records.files)) {
		paths.add(spec)
		for (const file of entry.hooks) paths.add(file)
		for (const test of Object.values(entry.tests)) {
			for (const file of test.deps) paths.add(file)
		}
	}
	return paths
}

/**
 * The sources the source map of the compiled file `file` names,
 * repository-relative; none when it has no map.
 *
 * e.g. `dist/src/user.js` → `['src/user.ts']`
 */
export function sourcesOf(repo: string, file: string): string[] {
	const absolute = path.join(repo, file)
	let map: { sourceRoot?: string; sources?: string[] }
	try {
		const text = readFileSync(absolute, 'utf8')
		const url = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(text)?.[1]
		if (url === undefined) return []
		map = JSON.parse(
			url.startsWith('data:')
				? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString()
				: readFileSync(path.resolve(path.dirname(absolute), url), 'utf8'),
		) as typeof map
	} catch {
		return []
	}
	const root = path.resolve(path.dirname(absolute), map.sourceRoot ?? '')
	return (map.sources ?? []).map((source) =>
		path.relative(repo, path.resolve(root, source)).split(path.sep).join('/'),
	)
}
