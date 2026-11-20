import picomatch from 'picomatch'

import { isPackagePath } from '../../shared/src/packages.ts'

/**
 * The dependency record and the rules that read it. Jest gives every test
 * file a module registry of its own, so the record is one dependency list per
 * test file, with the state of each of its tests beside it.
 */
export const RECORDS_VERSION = 3

export type TestState = 'passed' | 'failed' | 'skipped'

export interface FileRecord {
	/** Modules the test file loaded and files it read, itself aside, and the directories of the installed packages it loaded. */
	deps: string[]
	/** Full name of every test in the file → how it ended the last time it ran. */
	tests: Record<string, TestState>
	/** package.json files among `deps` the test read itself: compared in full, dependency fields included. */
	manifests?: string[]
	/** The file failed outside any test: a syntax error, a failed `beforeAll`. */
	failed?: boolean
}

/** What one Jest run recorded. Paths are repository-relative with `/`. */
export interface RunRecord {
	at: number
	/** Files every test file depends on: what `globalSetup` and Jest's own process loaded. */
	global: string[]
	files: Record<string, FileRecord>
	/** Tests named `pending` in a `-t` run did not run; `files` holds only the ones that did. */
	partial: boolean
}

export interface Records {
	version: number
	at: number
	global: string[]
	files: Record<string, FileRecord>
}

/** Whether the change to `file`, which the test file `spec` loaded, can alter what `spec` does. */
export type Affects = (spec: string, file: string) => boolean

export interface Options {
	/** Test file glob → globs of files those test files depend on that nothing reads. */
	dependencies?: Record<string, string | string[]>
}

export type Decision = { run: false } | { run: true; reason: string }

export function emptyRecords(): Records {
	return { version: RECORDS_VERSION, at: 0, global: [], files: {} }
}

const list = (value: string | string[] | undefined): string[] =>
	value === undefined ? [] : [value].flat()

/** Every glob the `dependencies` option names. */
export function ruleGlobs(options: Options): string[] {
	return Object.values(options.dependencies ?? {}).flatMap(list)
}

/** The first of `changed` the test file `spec` depends on. */
function changedDependency(
	records: Records,
	spec: string,
	changed: string[],
	options: Options,
	affects: Affects | undefined,
): string | undefined {
	const deps = new Set([
		spec,
		...records.global,
		...(records.files[spec]?.deps ?? []),
	])
	const globs: string[] = []
	for (const [tests, files] of Object.entries(options.dependencies ?? {})) {
		if (picomatch.isMatch(spec, tests, { dot: true }))
			globs.push(...list(files))
	}
	const matches =
		globs.length > 0 ? picomatch(globs, { dot: true }) : () => false
	const global = new Set(records.global)
	return changed.find((file) => {
		if (matches(file)) return true
		if (!deps.has(file)) return false
		return file === spec || global.has(file) || !affects || affects(spec, file)
	})
}

/**
 * Decides, per test file, whether it runs. A file is skipped only when it has
 * a record, nothing the record names changed, and every test in it ended
 * other than failed the last time it ran.
 */
export function select(
	records: Records,
	specs: string[],
	changed: string[],
	options: Options = {},
	affects?: Affects,
): Record<string, Decision> {
	const result: Record<string, Decision> = {}
	for (const spec of specs) {
		const entry = records.files[spec]
		if (!entry) {
			result[spec] = { run: true, reason: 'no record' }
			continue
		}
		const hit = changedDependency(records, spec, changed, options, affects)
		if (hit !== undefined)
			result[spec] = { run: true, reason: `changed: ${hit}` }
		else if (entry.failed || Object.values(entry.tests).includes('failed'))
			result[spec] = { run: true, reason: 'failed last time' }
		else result[spec] = { run: false }
	}
	return result
}

const union = (a: string[] | undefined, b: string[]): string[] =>
	[...new Set([...(a ?? []), ...b])].sort()

/**
 * Merges what a run recorded into the stored record. `changed` is what the
 * anchor diff reported before the run started.
 *
 * 1. A stored file record that `changed` invalidates is dropped first: if the
 *    run then left the file out (a path filter, `--bail`), it has no record
 *    and runs next time.
 * 2. A file that ran in full replaces its record.
 * 3. A file that ran in part (`-t`) is marked failed unless a record survived
 *    step 1: the tests left out never ran against the current files. With a
 *    surviving record, the tests that ran replace their state and the
 *    dependencies are unioned.
 */
export function mergeRecords(
	stored: Records | null,
	run: RunRecord,
	changed: string[],
	options: Options = {},
	affects?: Affects,
): Records {
	const out =
		stored?.version === RECORDS_VERSION
			? structuredClone(stored)
			: emptyRecords()
	const verdict = select(out, Object.keys(out.files), changed, options, affects)
	for (const [spec, decision] of Object.entries(verdict)) {
		if (decision.run && decision.reason.startsWith('changed')) {
			delete out.files[spec]
		}
	}
	// A run of every recorded test file saw everything `global` can hold; a
	// run of some of them did not load what only the others make a transformer
	// look up, so what the record already names stays.
	const complete = Object.keys(out.files).every((spec) => spec in run.files)
	if (Object.keys(run.files).length > 0) {
		// Packages stay either way: with a warm transform cache Jest does not
		// load the transformer's packages, and a later run without it would.
		out.global = complete
			? union(out.global.filter(isPackagePath), run.global)
			: union(out.global, run.global)
	}
	for (const [spec, entry] of Object.entries(run.files)) {
		const previous = out.files[spec]
		if (!run.partial) out.files[spec] = entry
		else if (!previous) out.files[spec] = { ...entry, failed: true }
		else {
			out.files[spec] = {
				deps: union(previous.deps, entry.deps),
				...(previous.manifests || entry.manifests
					? { manifests: union(previous.manifests, entry.manifests ?? []) }
					: {}),
				tests: { ...previous.tests, ...entry.tests },
				...(entry.failed || previous.failed ? { failed: true } : {}),
			}
		}
	}
	out.at = Math.max(out.at, run.at)
	return out
}

/** Every repository path the record names: what the anchor has to cover. */
export function recordedPaths(records: Records): Set<string> {
	const paths = new Set<string>(records.global)
	for (const [spec, entry] of Object.entries(records.files)) {
		paths.add(spec)
		for (const file of entry.deps) paths.add(file)
	}
	return paths
}

/** Every package.json a test file read itself. */
export function readManifests(records: Records): Set<string> {
	return new Set(
		Object.values(records.files).flatMap((entry) => entry.manifests ?? []),
	)
}
