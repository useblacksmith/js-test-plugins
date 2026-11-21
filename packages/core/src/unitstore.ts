import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { Narrowing, type ResolvedDigest } from './narrow.ts'
import { isPackagePath } from './packages.ts'
import { specPath, type Records } from './record.ts'
import type { Affects } from './select.ts'
import { readJson, writeJson } from './store.ts'

/**
 * The function record of narrowing, kept beside the dependency record: what
 * each module was made of when the tests last ran against it, and which of
 * its functions each test file entered. With it a change inside a file
 * reruns the test files it can reach, not every one that loaded the file.
 */
const UNITS_VERSION = 2
/** What a digest holds. A record written with less in each is still read, and its digests are taken again. */
const DIGESTS = 4
const CODE = /\.[cm]?[jt]sx?$/

interface Units {
	version: typeof UNITS_VERSION
	/** `at` of the dependency record this was written with: any other record is not the one these tests ran under. */
	at: number
	digests?: number
	/** Repository-relative module → its digest, and the hash of the content it was taken from. */
	modules: Record<string, ResolvedDigest>
	hashes: Record<string, string>
	/** Test file (its key in the dependency record) → module → the functions the test file entered in it. */
	tests: Record<string, Record<string, string[]>>
}

/**
 * How the runner takes a module's digest: what it is made of, with its
 * import specifiers resolved the way the runner resolves them.
 */
export interface Digester {
	/**
	 * The digest of the repository-relative `module`, whose content is `code`;
	 * null when it cannot be told. `before` is the one recorded for it, and
	 * `when` says whether a selection is comparing with it (`plan`) or a run
	 * is recording what its tests ran against (`commit`).
	 */
	digest(
		module: string,
		code: string,
		before: ResolvedDigest | undefined,
		when: 'plan' | 'commit',
	): ResolvedDigest | null
	/** Whether this run took the module's digest itself: it is used whatever the record holds. */
	fresh?(module: string): boolean
}

function readUnits(file: string, records: Records | null): Units | null {
	const units = loadUnits(readJson<StoredUnits | LegacyUnits>(file))
	if (!units || !records || units.at !== records.at) return null
	return units
}

/** The layout before this one: `tests` named each module and its functions under every test file. */
type LegacyUnits = Omit<Units, 'version'> & { version: 1 }

/**
 * The record as the file holds it. Most test files enter the same functions
 * of the same modules, so `hits` holds each module with a list of functions
 * once, as a position in `paths` followed by the names, and a test file is a
 * list of positions in `hits`.
 */
interface StoredUnits extends Omit<Units, 'tests'> {
	paths: string[]
	hits: [number, ...string[]][]
	tests: Record<string, number[]>
}

export function storeUnits(units: Units): StoredUnits {
	const paths: string[] = []
	const pathAt = new Map<string, number>()
	const hits: StoredUnits['hits'] = []
	const hitAt = new Map<string, number>()
	const tests: StoredUnits['tests'] = {}
	for (const [spec, modules] of Object.entries(units.tests)) {
		tests[spec] = Object.entries(modules).map(([module, entered]) => {
			const key = JSON.stringify([module, entered])
			let hit = hitAt.get(key)
			if (hit === undefined) {
				let at = pathAt.get(module)
				if (at === undefined) {
					at = paths.length
					pathAt.set(module, at)
					paths.push(module)
				}
				hit = hits.length
				hitAt.set(key, hit)
				hits.push([at, ...entered])
			}
			return hit
		})
	}
	return { ...units, paths, hits, tests }
}

export function loadUnits(stored: StoredUnits | LegacyUnits | null): Units | null {
	if (stored === null || typeof stored !== 'object') return null
	if (stored.version === 1 && !('hits' in stored)) return { ...stored, version: UNITS_VERSION }
	if (stored.version !== UNITS_VERSION || !('hits' in stored)) return null
	try {
		const { paths, hits, tests: positions, ...rest } = stored
		const tests: Units['tests'] = {}
		for (const [spec, list] of Object.entries(positions)) {
			const modules: Record<string, string[]> = {}
			for (const position of list) {
				const hit = hits[position]
				const module = hit === undefined ? undefined : paths[hit[0]]
				if (hit === undefined || typeof module !== 'string') throw new Error('not a function record')
				modules[module] = hit.slice(1) as string[]
			}
			tests[spec] = modules
		}
		return { ...rest, tests }
	} catch {
		return null
	}
}

/**
 * For the `changed` files, whether a test file that loaded one has to rerun
 * for it; `undefined` without a function record that belongs to `records`.
 */
export function affecting(
	repo: string,
	file: string,
	digester: Digester,
	records: Records,
	changed: readonly string[],
): Affects | undefined {
	const units = readUnits(file, records)
	if (!units) return undefined
	const current = new Map<string, ResolvedDigest | null>()
	for (const module of changed) {
		// A package is no module of the record: its change reaches every test that loaded it.
		if (isPackagePath(module)) continue
		let after: ResolvedDigest | null = null
		const before = units.modules[module]
		if (before) {
			try {
				after = digester.digest(
					module,
					readFileSync(path.join(repo, module), 'utf8'),
					before,
					'plan',
				)
			} catch {}
		}
		current.set(module, after)
	}
	const narrowing = new Narrowing(units.modules, current)
	const loaded = new Map<string, Set<string>>()
	return (spec, module) => {
		const entry = records.files[spec]
		if (!entry) return true
		let deps = loaded.get(spec)
		if (!deps) loaded.set(spec, (deps = new Set([specPath(spec), ...entry.deps])))
		return narrowing.affects(module, { deps, ran: units.tests[spec] })
	}
}

/** What a test file of a run entered: module → functions; `partial` when the run left some of its tests out. */
export interface Entered {
	ran: Record<string, string[]> | undefined
	partial?: boolean
}

/**
 * Brings the function record in line with `records`, which a run just
 * merged: `ran` is what each test file of the run entered, and every module
 * a recorded test file loaded gets the digest of the file as it is now. The
 * anchor moves to the same files, so a test file the run left out was either
 * untouched by what changed or lost its record.
 */
export function updateUnits(
	repo: string,
	file: string,
	digester: Digester,
	before: Records | null,
	records: Records,
	ran: ReadonlyMap<string, Entered>,
): void {
	const units = readUnits(file, before) ?? {
		version: UNITS_VERSION,
		at: 0,
		modules: {},
		hashes: {},
		tests: {},
	}
	if (units.digests !== DIGESTS) {
		units.hashes = {}
		units.digests = DIGESTS
	}
	for (const [spec, { ran: entered, partial }] of ran) {
		const previous = units.tests[spec]
		if (!entered) delete units.tests[spec]
		else if (partial) {
			// A run of some of the file's tests entered only what those enter;
			// without what the others entered before, the file gets no record
			// and reruns on any change to what it loaded.
			if (!previous) continue
			const all: Record<string, string[]> = { ...previous }
			for (const [module, names] of Object.entries(entered)) {
				all[module] = [...new Set([...(previous[module] ?? []), ...names])].sort()
			}
			units.tests[spec] = all
		} else units.tests[spec] = entered
	}
	const modules = new Set<string>()
	for (const [spec, entry] of Object.entries(records.files)) {
		modules.add(specPath(spec))
		for (const dep of entry.deps) {
			if (CODE.test(dep) && !isPackagePath(dep)) modules.add(dep)
		}
	}
	for (const spec of Object.keys(units.tests)) {
		if (!records.files[spec]) delete units.tests[spec]
	}
	for (const module of Object.keys(units.modules)) {
		if (!modules.has(module)) {
			delete units.modules[module]
			delete units.hashes[module]
		}
	}
	for (const module of modules) {
		let code: string
		try {
			code = readFileSync(path.join(repo, module), 'utf8')
		} catch {
			delete units.modules[module]
			delete units.hashes[module]
			continue
		}
		const hash = createHash('sha1').update(code).digest('hex')
		if (units.hashes[module] === hash && !digester.fresh?.(module)) continue
		const digest = digester.digest(module, code, units.modules[module], 'commit')
		units.hashes[module] = hash
		if (digest) units.modules[module] = digest
		else delete units.modules[module]
	}
	units.at = records.at
	writeJson(file, storeUnits(units))
}

/**
 * Writes the function record that goes with `records`, which was put
 * together from several cache entries: what each test file entered comes
 * from the entry its record came from. A module two entries saw differently
 * is left out, and its digest is taken again after the run.
 */
export function mergeUnits(
	file: string,
	records: Records,
	sources: ReadonlyArray<{ records: Records; units: string; specs: Iterable<string> }>,
): void {
	const merged: Units = {
		version: UNITS_VERSION,
		at: records.at,
		digests: DIGESTS,
		modules: {},
		hashes: {},
		tests: {},
	}
	const differs = new Set<string>()
	let any = false
	for (const source of sources) {
		const units = readUnits(source.units, source.records)
		if (!units || units.digests !== DIGESTS) continue
		any = true
		for (const spec of source.specs) {
			const entered = units.tests[spec]
			if (entered && records.files[spec]) merged.tests[spec] = entered
		}
		for (const [module, digest] of Object.entries(units.modules)) {
			const hash = units.hashes[module]
			if (hash === undefined || differs.has(module)) continue
			const known = merged.hashes[module]
			if (known === undefined) {
				merged.modules[module] = digest
				merged.hashes[module] = hash
			} else if (known !== hash) {
				differs.add(module)
				delete merged.modules[module]
				delete merged.hashes[module]
			}
		}
	}
	if (!any) return dropUnits(file)
	writeJson(file, storeUnits(merged))
}

/** A run that does not narrow leaves no function record: the one before it is not of the tests it ran. */
export function dropUnits(file: string): void {
	if (existsSync(file)) rmSync(file, { force: true })
}
