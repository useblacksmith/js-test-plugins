import { existsSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import MagicString from 'magic-string'
import type { Vitest } from 'vitest/node'
import { UNITS_SUFFIX } from '../../shared/src/fs-recorder.ts'
import {
	Narrowing,
	resolveDigest,
	type RecordedTest,
	type ResolvedDigest,
} from '../../shared/src/narrow.ts'
import { analyze, footer } from '../../shared/src/units.ts'

export const UNITS_FILE = 'blacksmith-units.json'

/** The function record kept for one anchor: digests are only as current as the anchor they are compared under. */
export function unitsFile(snapshotFile: string): string {
	return path.join(
		path.dirname(snapshotFile),
		path.basename(snapshotFile).replace(/^blacksmith/, 'blacksmith-units'),
	)
}
const UNITS_VERSION = 1

interface UnitRecords {
	version: typeof UNITS_VERSION
	/** Repo-relative module → its digest when a test last ran it. */
	modules: Record<string, ResolvedDigest>
	/** Repo-relative test file → module → the functions the test entered in it. */
	tests: Record<string, Record<string, string[]>>
}

// On the process: a project with its own root evaluates the config, and so
// the plugin, a second time.
const DIGESTS = Symbol.for('blacksmith.vitest.unitDigests')
const holder = globalThis as unknown as {
	[DIGESTS]?: Map<string, ResolvedDigest>
}
const digests = (holder[DIGESTS] ??= new Map())

function relative(repo: string, file: string): string | null {
	const inRepo = path.relative(repo, file)
	if (inRepo.startsWith('..') || path.isAbsolute(inRepo)) return null
	return inRepo.split(path.sep).join('/')
}

/** The file behind a module id, `null` for one that is not a plain file of the repository. */
function sourceFile(repo: string, id: string): string | null {
	if (id.includes('\0') || id.includes('?') || id.includes('/node_modules/')) return null
	if (!path.isAbsolute(id)) return null
	return relative(repo, id)
}

type Resolve = (
	specifier: string,
	importer: string,
) => Promise<{ id: string; external?: boolean | string } | null>

async function resolveSpecifiers(
	repo: string,
	file: string,
	specifiers: Iterable<string>,
	resolve: Resolve,
): Promise<Record<string, string>> {
	const resolved: Record<string, string> = {}
	for (const specifier of new Set(specifiers)) {
		try {
			const target = await resolve(specifier, file)
			if (!target || target.external) continue
			const inRepo = sourceFile(repo, target.id)
			if (inRepo !== null) resolved[specifier] = inRepo
		} catch {}
	}
	return resolved
}

/**
 * Makes every top-level function of a repository module report when a test
 * enters it, and keeps the module's digest for the run's record. `null`
 * leaves the module alone: its changes rerun every test that loaded it.
 */
export async function instrument(
	repo: string,
	code: string,
	id: string,
	resolve: Resolve,
): Promise<{ code: string; map: ReturnType<MagicString['generateMap']> } | null> {
	const file = sourceFile(repo, id)
	if (file === null) return null
	const analysis = analyze(code, id)
	if (!analysis) {
		digests.delete(file)
		return null
	}
	digests.set(
		file,
		resolveDigest(
			analysis.digest,
			await resolveSpecifiers(repo, id, analysis.digest.sources, resolve),
		),
	)
	const output = new MagicString(code)
	for (const [at, text] of analysis.marks) output.appendRight(at, text)
	output.append(footer(file))
	return { code: output.toString(), map: output.generateMap({ hires: 'boundary' }) }
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']

/** A relative specifier's file, by the extensions and index files bundlers try. */
function resolveRelative(repo: string, importer: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(importer), specifier)
	const bases = [base, base.replace(/\.[cm]?js$/, ''), path.join(base, 'index')]
	for (const candidate of bases) {
		for (const extension of EXTENSIONS) {
			const file = candidate + extension
			try {
				if (statSync(file).isFile()) return relative(repo, file)
			} catch {}
		}
	}
	return null
}

/**
 * Vite does not transform a module it holds a cached result for, so a file
 * put back to an earlier content keeps the digest of the content between.
 * Brings every digest this run did not produce in line with the file: its
 * old specifiers still hold when it imports the same modules, and without
 * that the module is forgotten, so its changes rerun every test that loaded it.
 */
async function refreshDigests(repo: string, records: UnitRecords): Promise<void> {
	await Promise.all(
		Object.entries(records.modules).map(async ([module, stored]) => {
			if (digests.has(module)) return
			let code: string
			try {
				code = await readFile(path.join(repo, module), 'utf8')
			} catch {
				return
			}
			const analysis = analyze(code, path.join(repo, module))
			if (!analysis) {
				delete records.modules[module]
				return
			}
			const current = resolveDigest(analysis.digest, stored.specifiers)
			if (JSON.stringify(current) === JSON.stringify({ ...current, ...stored })) return
			const known = analysis.digest.sources.every(
				(source) =>
					Object.hasOwn(stored.specifiers, source) || stored.sources.includes(`?${source}`),
			)
			if (known) records.modules[module] = current
			else delete records.modules[module]
		}),
	)
}

async function readUnits(file: string): Promise<UnitRecords | null> {
	try {
		const records = JSON.parse(
			await readFile(file, 'utf8'),
		) as UnitRecords
		return records.version === UNITS_VERSION ? records : null
	} catch {
		return null
	}
}

/**
 * Folds what the workers left under `recordRoot` into the record at `units`.
 * A `partial` run entered only what some of a file's tests enter, so what the
 * others entered before stays; a file without an earlier record gets none,
 * and reruns on any change to what it loaded.
 */
export async function updateUnits(
	vitest: Vitest,
	repo: string,
	units: string,
	recordRoot: string | undefined,
	partial: boolean,
): Promise<void> {
	const records = (await readUnits(units)) ?? {
		version: UNITS_VERSION,
		modules: {},
		tests: {},
	}
	const pieces = recordRoot ? path.join(recordRoot, 'deps') : null
	let names: string[] = []
	try {
		if (pieces) names = await readdir(pieces)
	} catch {}
	const fresh = new Map<string, Record<string, Set<string>>>()
	for (const name of names) {
		if (!name.endsWith(UNITS_SUFFIX) || !pieces) continue
		const file = path.join(pieces, name)
		try {
			const piece = JSON.parse(await readFile(file, 'utf8')) as {
				test: string
				files: Record<string, string[]>
			}
			const test = relative(repo, piece.test)
			if (test !== null) {
				// A test file several projects run entered what any of them did.
				let ran = fresh.get(test)
				if (!ran) fresh.set(test, (ran = {}))
				for (const [module, entered] of Object.entries(piece.files)) {
					const all = (ran[module] ??= new Set())
					for (const unit of entered) all.add(unit)
				}
			}
		} catch {}
		await rm(file, { force: true })
	}
	for (const [test, ran] of fresh) {
		const previous = records.tests[test]
		if (partial) {
			if (!previous) continue
			for (const [module, entered] of Object.entries(previous)) {
				const all = (ran[module] ??= new Set())
				for (const unit of entered) all.add(unit)
			}
		}
		records.tests[test] = Object.fromEntries(
			Object.entries(ran).map(([module, entered]) => [module, [...entered].sort()]),
		)
	}
	for (const test of Object.keys(records.tests)) {
		if (!existsSync(path.join(repo, test))) delete records.tests[test]
	}
	for (const module of Object.keys(records.modules)) {
		if (!existsSync(path.join(repo, module))) delete records.modules[module]
	}
	await writeUnitsFile(units, records)
}

async function writeUnitsFile(file: string, records: UnitRecords): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(records))
	await rename(tmp, file)
}

/**
 * For the `changed` files, a predicate telling whether a recorded test has
 * to rerun for the ones it loaded; `null` without a record to narrow with.
 */
export async function narrowing(
	repo: string,
	units: string,
	changed: Iterable<string>,
): Promise<((test: string, deps: ReadonlySet<string>, changed: readonly string[]) => boolean) | null> {
	const records = await readUnits(units)
	if (!records) return null
	const current = new Map<string, ResolvedDigest | null>()
	for (const file of changed) {
		const module = relative(repo, file)
		if (module === null) continue
		const before = records.modules[module]
		let after: ResolvedDigest | null = null
		if (before) {
			try {
				const analysis = analyze(await readFile(file, 'utf8'), file)
				// A specifier the module did not have before resolves to nothing
				// known, and counts as a module no test has loaded.
				if (analysis) {
					const specifiers = { ...before.specifiers }
					for (const specifier of analysis.digest.sources) {
						if (specifier in specifiers || !specifier.startsWith('.')) continue
						const target = resolveRelative(repo, file, specifier)
						if (target !== null) specifiers[specifier] = target
					}
					after = resolveDigest(analysis.digest, specifiers)
				}
			} catch {}
		}
		current.set(module, after)
	}
	const narrowing = new Narrowing(records.modules, current)
	const relativeDeps = new Map<ReadonlySet<string>, RecordedTest['deps']>()
	return (test, deps, changedDeps) => {
		const name = relative(repo, test)
		if (name === null) return true
		let inRepo = relativeDeps.get(deps)
		if (!inRepo) {
			const set = new Set<string>()
			for (const dep of deps) {
				const module = relative(repo, dep)
				if (module !== null) set.add(module)
			}
			relativeDeps.set(deps, (inRepo = set))
		}
		const recorded: RecordedTest = { deps: inRepo, ran: records.tests[name] }
		return changedDeps.some((dep) => {
			const module = relative(repo, dep)
			return module === null || narrowing.affects(module, recorded)
		})
	}
}

/**
 * Moves the recorded digests on to the files as they are now. Only a run
 * that writes its anchor does: the anchor is what says a file changed, and a
 * digest ahead of it would hide the change from the tests the run left out.
 */
export async function advanceDigests(repo: string, file: string): Promise<void> {
	const records = await readUnits(file)
	if (!records) return
	for (const [module, digest] of digests) records.modules[module] = digest
	await refreshDigests(repo, records)
	await writeUnitsFile(file, records)
}
