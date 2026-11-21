import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { PACKAGES_FILE, readPackages, writePackages, type PackageRecords } from './packages.js'
import type { DependencyRecords } from './records.js'
import { readUnits, writeUnits } from './units.js'

/**
 * One cache entry's files, and the test files (as its records name them:
 * relative to the root config's root, and to the repository) whose records
 * the run takes from it.
 */
export interface Source {
	/** Its dependency record. */
	records: string
	/** The directory its package record is in. */
	dir: string
	/** Its function record. */
	units: string
	fromRoot: ReadonlySet<string>
	fromRepo: ReadonlySet<string>
}

async function readJson<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(file, 'utf8')) as T
	} catch {
		return null
	}
}

/**
 * Writes the records a run starts from, each test file's from the entry it
 * is taken from: what the run saves afterwards has to hold a record for
 * every test file it vouches for, whichever shard recorded it. The first
 * source is the base, kept whole; the others add their test files only.
 */
export async function mergeRecords(
	sources: readonly Source[],
	into: { records: string; dir: string; units: string },
): Promise<void> {
	let records: DependencyRecords | null = null
	let packages: PackageRecords | null = null
	for (const source of sources) {
		const theirs = await readJson<DependencyRecords>(source.records)
		if (theirs !== null && typeof theirs.projects === 'object') {
			if (records === null) records = theirs
			else if (records.version === theirs.version) addRecords(records, theirs, source.fromRoot)
		}
		const loaded = await readPackages(source.dir)
		if (loaded !== null) {
			if (packages === null) packages = loaded
			else addPackages(packages, loaded, source.fromRepo)
		}
	}
	if (records !== null) await writeFile(into.records, JSON.stringify(records))
	if (packages !== null) await writePackages(path.join(into.dir, PACKAGES_FILE), packages)
	await mergeUnits(sources, into.units)
}

function addRecords(
	into: DependencyRecords,
	from: DependencyRecords,
	tests: ReadonlySet<string>,
): void {
	for (const [name, theirs] of Object.entries(from.projects)) {
		const taken = Object.entries(theirs.files).filter(([test]) => tests.has(test))
		if (taken.length === 0) continue
		// The project's own dependencies (config, globalSetup) come with it
		// only when no entry before this one recorded the project.
		const fresh = into.projects[name] === undefined
		const mine = (into.projects[name] ??= { ...theirs, modules: [], files: {} })
		const at = new Map(mine.modules.map((module, index) => [module, index]))
		const position = (index: number): number => {
			const module = theirs.modules[index] ?? ''
			let found = at.get(module)
			if (found === undefined) {
				found = mine.modules.length
				at.set(module, found)
				mine.modules.push(module)
			}
			return found
		}
		if (fresh) {
			if (mine.config) mine.config = { ...mine.config, deps: mine.config.deps.map(position) }
			if (mine.globalSetup) {
				mine.globalSetup = { ...mine.globalSetup, deps: mine.globalSetup.deps.map(position) }
			}
		}
		for (const [test, record] of taken) {
			mine.files[test] = { ...record, deps: record.deps.map(position) }
		}
	}
}

function addPackages(
	into: PackageRecords,
	from: PackageRecords,
	tests: ReadonlySet<string>,
): void {
	const incomplete = new Set(into.incomplete ?? [])
	const theirs = new Set(from.incomplete ?? [])
	for (const test of tests) {
		const loaded = from.files[test]
		if (loaded === undefined) delete into.files[test]
		else into.files[test] = loaded
		if (theirs.has(test)) incomplete.add(test)
		else incomplete.delete(test)
	}
	// What either run loaded for itself: a change to any reruns everything.
	into.global = [...new Set([...into.global, ...from.global])]
	if (incomplete.size > 0) into.incomplete = [...incomplete]
	else delete into.incomplete
}

/**
 * A function record holds one digest per module, the module as it was at the
 * entry's commit, and what a test file entered is told against it. An entry
 * that saw a module differently than the ones before it adds nothing: its
 * test files rerun on any change to a file they loaded, until they run again.
 */
async function mergeUnits(sources: readonly Source[], into: string): Promise<void> {
	const [base, ...others] = sources
	if (base === undefined) return
	const merged = await readUnits(base.units)
	if (merged === null) return
	for (const source of others) {
		for (const test of source.fromRepo) delete merged.tests[test]
		const theirs = await readUnits(source.units)
		if (theirs === null) continue
		const agrees = Object.entries(theirs.modules).every(([module, digest]) => {
			const mine = merged.modules[module]
			return mine === undefined || JSON.stringify(mine) === JSON.stringify(digest)
		})
		if (!agrees) continue
		Object.assign(merged.modules, theirs.modules)
		for (const test of source.fromRepo) {
			const entered = theirs.tests[test]
			if (entered !== undefined) merged.tests[test] = entered
		}
	}
	await writeUnits(into, merged)
}
