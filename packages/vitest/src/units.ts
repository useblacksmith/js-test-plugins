import { statSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import MagicString from 'magic-string'
import { UNITS_SUFFIX } from '../../core/src/fs-recorder.ts'
import { resolveDigest, type ResolvedDigest } from '../../core/src/narrow.ts'
import type { Digester } from '../../core/src/unitstore.ts'
import { analyze, globalFooter } from '../../core/src/units.ts'

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
	const analysis = analyze(code, id, file)
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
	output.append(globalFooter(file))
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
 * How the function record takes a module's digest. One this run transformed
 * has the digest `instrument` took, with Vite's own resolution. Vite does
 * not transform a module it holds a cached result for, and a selection runs
 * before any transform: there the specifiers the recorded digest resolved
 * still hold, and a new relative one is found on disk. A module that imports
 * something neither can place is forgotten, so its changes rerun every test
 * that loaded it.
 */
export function digester(repo: string): Digester {
	return {
		fresh: (module) => digests.has(module),
		digest(module, code, before, when) {
			const taken = when === 'commit' ? digests.get(module) : undefined
			if (taken) return taken
			if (!before) return null
			const file = path.join(repo, module)
			const analysis = analyze(code, file)
			if (!analysis) return null
			const specifiers = { ...before.specifiers }
			for (const specifier of analysis.digest.sources) {
				if (specifier in specifiers || !specifier.startsWith('.')) continue
				const target = resolveRelative(repo, file, specifier)
				if (target !== null) specifiers[specifier] = target
			}
			// A selection counts a specifier it cannot place as a module no test has loaded; a record does not keep one.
			const known = analysis.digest.sources.every(
				(source) =>
					Object.hasOwn(specifiers, source) || before.sources.includes(`?${source}`),
			)
			return when === 'commit' && !known ? null : resolveDigest(analysis.digest, specifiers)
		},
	}
}

/**
 * What the workers left under `recordRoot`: repository-relative test file →
 * module → the functions the test file entered in it. A test file several
 * projects run entered what any of them did.
 */
export async function collectEntered(
	repo: string,
	recordRoot: string | undefined,
): Promise<Map<string, Record<string, string[]>>> {
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
	return new Map(
		[...fresh].map(([test, ran]) => [
			test,
			Object.fromEntries(
				Object.entries(ran).map(([module, entered]) => [module, [...entered].sort()]),
			),
		]),
	)
}
