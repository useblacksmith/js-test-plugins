import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
	Narrowing,
	resolveDigest,
	type ResolvedDigest,
} from '../../shared/src/narrow.ts'
import { isPackagePath } from '../../shared/src/packages.ts'
import { analyze } from '../../shared/src/units.ts'
import type { Affects, Records } from './core.ts'
import { sourceFile } from './mark.ts'
import { readJson } from './project.ts'
import { dataDir, suffix, type Resolve, type Shard, type State } from './state.ts'

/**
 * The function record of `narrow`, kept beside the dependency record: what
 * each module was made of when the tests last ran against it, and which of
 * its functions each test file entered.
 */
const UNITS_VERSION = 2
/** What a digest holds. A record written with less in each is still read, and its digests are taken again. */
const DIGESTS = 3
const CODE = /\.[cm]?[jt]sx?$/

interface Units {
	version: typeof UNITS_VERSION
	/** `at` of the dependency record this was written with: any other record is not the one these tests ran under. */
	at: number
	digests?: number
	/** Repository-relative module → its digest, and the hash of the content it was taken from. */
	modules: Record<string, ResolvedDigest>
	hashes: Record<string, string>
	/** Repository-relative test file → module → the functions the test file entered in it. */
	tests: Record<string, Record<string, string[]>>
}

export const unitsFile = (ctx: State, shard: Shard | null): string =>
	path.join(dataDir(ctx.cwd), `units${suffix(shard)}.json`)

function readUnits(
	ctx: State,
	shard: Shard | null,
	records: Records | null,
	file = unitsFile(ctx, shard),
): Units | null {
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

function digestOf(
	repo: string,
	file: string,
	code: string,
	resolve: Resolve,
): ResolvedDigest | null {
	const absolute = path.join(repo, file)
	// A CommonJS module too: what it loads says which changes can reach a test through it.
	const analysis = analyze(code, absolute, undefined, true)
	if (!analysis) return null
	const specifiers: Record<string, string> = {}
	for (const specifier of new Set(analysis.digest.sources)) {
		const target = resolve(absolute, specifier)
		const inRepo = target === null ? null : sourceFile(repo, target)
		if (inRepo !== null) specifiers[specifier] = inRepo
	}
	return resolveDigest(analysis.digest, specifiers)
}

/**
 * For the `changed` files, whether a test file that loaded one has to rerun
 * for it; `undefined` without a function record that belongs to `records`.
 */
export function affecting(
	ctx: State,
	shard: Shard | null,
	records: Records,
	changed: string[],
	/** The function record, when it is not the data directory's: a restored cache entry's. */
	file?: string,
): Affects | undefined {
	const units = readUnits(ctx, shard, records, file)
	if (!units) return undefined
	const current = new Map<string, ResolvedDigest | null>()
	for (const file of changed) {
		// A package is no module of the record: its change reaches every test that loaded it.
		if (isPackagePath(file)) continue
		let after: ResolvedDigest | null = null
		if (units.modules[file]) {
			try {
				after = digestOf(
					ctx.repo,
					file,
					readFileSync(path.join(ctx.repo, file), 'utf8'),
					ctx.resolve,
				)
			} catch {}
		}
		current.set(file, after)
	}
	const narrowing = new Narrowing(units.modules, current)
	const loaded = new Map<string, Set<string>>()
	return (spec, file) => {
		const entry = records.files[spec]
		if (!entry) return true
		let deps = loaded.get(spec)
		if (!deps) loaded.set(spec, (deps = new Set([spec, ...entry.deps])))
		return narrowing.affects(file, { deps, ran: units.tests[spec] })
	}
}

/**
 * Brings the function record in line with `records`, which a run just
 * merged: `ran` is what each test file of the run entered, and every module
 * a recorded test file loaded gets the digest of the file as it is now. The
 * anchor moves to the same files, so a test file the run left out was either
 * untouched by what changed or lost its record.
 */
export function updateUnits(
	ctx: State,
	shard: Shard | null,
	before: Records | null,
	records: Records,
	ran: ReadonlyMap<string, Record<string, string[]> | undefined>,
	partial: boolean,
): void {
	const units = readUnits(ctx, shard, before) ?? {
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
	for (const [spec, entered] of ran) {
		const previous = units.tests[spec]
		if (!entered) delete units.tests[spec]
		else if (partial && previous) {
			// A `-t` run entered only what some of the file's tests enter.
			const all: Record<string, string[]> = { ...previous }
			for (const [module, names] of Object.entries(entered)) {
				all[module] = [...new Set([...(previous[module] ?? []), ...names])].sort()
			}
			units.tests[spec] = all
		} else units.tests[spec] = entered
	}
	const modules = new Set<string>()
	for (const [spec, entry] of Object.entries(records.files)) {
		modules.add(spec)
		for (const file of entry.deps) {
			if (CODE.test(file) && !isPackagePath(file)) modules.add(file)
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
			code = readFileSync(path.join(ctx.repo, module), 'utf8')
		} catch {
			delete units.modules[module]
			delete units.hashes[module]
			continue
		}
		const hash = createHash('sha1').update(code).digest('hex')
		if (units.hashes[module] === hash) continue
		const digest = digestOf(ctx.repo, module, code, ctx.resolve)
		units.hashes[module] = hash
		if (digest) units.modules[module] = digest
		else delete units.modules[module]
	}
	units.at = records.at
	writeFileSync(unitsFile(ctx, shard), JSON.stringify(storeUnits(units)))
}

/**
 * Writes the function record that goes with `records`, which was put
 * together from several cache entries: what each test file entered comes
 * from the entry its record came from. A module two entries saw differently
 * is left out, and its digest is taken again after the run.
 */
export function mergeUnits(
	ctx: State,
	shard: Shard | null,
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
		const units = readUnits(ctx, shard, source.records, source.units)
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
	if (!any) return dropUnits(ctx, shard)
	writeFileSync(unitsFile(ctx, shard), JSON.stringify(storeUnits(merged)))
}

/** A run without `narrow` leaves no function record: the one before it is not of the tests it ran. */
export function dropUnits(ctx: State, shard: Shard | null): void {
	const file = unitsFile(ctx, shard)
	if (existsSync(file)) rmSync(file, { force: true })
}
