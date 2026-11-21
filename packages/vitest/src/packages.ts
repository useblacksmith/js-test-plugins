import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Vitest } from 'vitest/node'

import { PACKAGES_SUFFIX } from '../../core/src/fs-recorder.ts'
import { PackageLinks, packageDir } from '../../core/src/packages.ts'

/**
 * The installed packages each test file loaded. Vitest's own record ends at
 * `node_modules`, so this one is kept beside it: an install then reruns the
 * test files that loaded a package whose version changed, not every one.
 */
function relative(repo: string, file: string): string | null {
	const result = path.relative(repo, file)
	if (result === '' || result.startsWith('..') || path.isAbsolute(result)) {
		return null
	}
	return result.split(path.sep).join('/')
}

/** The directory of the package `name` as a module in `from` resolves it, without loading anything. */
function findPackage(from: string, name: string): string | null {
	let dir = from
	for (;;) {
		const candidate = path.join(dir, 'node_modules', name)
		if (existsSync(path.join(candidate, 'package.json'))) return candidate
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\s]+)['"]/g

const EXTENSIONS = ['', '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']

/** The file a relative import in `from` names, with the extension or index file it leaves out. */
function localFile(from: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(from), specifier)
	const stems = [base, base.replace(/\.[cm]?js$/, ''), path.join(base, 'index')]
	for (const stem of stems) {
		for (const extension of EXTENSIONS) {
			try {
				if (statSync(stem + extension).isFile()) return stem + extension
			} catch {}
		}
	}
	return null
}

type Alias = { find: string | RegExp; replacement: string }

/** `specifier` as the first of `aliases` that matches rewrites it, as Vite does. */
function aliased(specifier: string, aliases: readonly Alias[]): string {
	for (const { find, replacement } of aliases) {
		if (typeof find !== 'string') {
			if (find.test(specifier)) return specifier.replace(find, replacement)
		} else if (specifier === find || specifier.startsWith(`${find}/`)) {
			return replacement + specifier.slice(find.length)
		}
	}
	return specifier
}

/** The packages the source file `file` names in its imports, and those the files of the repository it imports name. */
function importedPackages(
	file: string,
	aliases: readonly Alias[],
	seen = new Set<string>(),
): string[] {
	if (seen.has(file)) return []
	seen.add(file)
	let source: string
	try {
		source = readFileSync(file, 'utf8')
	} catch {
		return []
	}
	const found: string[] = []
	for (const [, written] of source.matchAll(SPECIFIER)) {
		const specifier = written && aliased(written, aliases)
		if (specifier?.startsWith('.') || (specifier && path.isAbsolute(specifier))) {
			const local = localFile(file, specifier)
			const installed = local && packageDir(local)
			if (installed) found.push(installed)
			else if (local) found.push(...importedPackages(local, aliases, seen))
			continue
		}
		if (!specifier || /^[./]|^[a-z]+:/i.test(specifier)) continue
		const parts = specifier.split('/')
		const name = specifier.startsWith('@')
			? parts.slice(0, 2).join('/')
			: parts[0]
		const dir = name ? findPackage(path.dirname(file), name) : null
		if (dir) found.push(dir)
	}
	return found
}

/**
 * The packages a run loads outside any test file, more than fewer: Vitest,
 * what the config and globalSetup files import, and everything those declare
 * as a dependency. Nothing here tells which of them the process really loaded.
 */
export function globalPackages(vitest: Vitest, repo: string): string[] {
	const queue: string[] = []
	const own = findPackage(vitest.config.root, 'vitest')
	if (own) queue.push(own)
	const sources: [string, readonly Alias[]][] = []
	for (const project of [vitest.getRootProject(), ...vitest.projects]) {
		const config = project.vite.config
		// A config file is loaded before its aliases exist; globalSetup after.
		if (config.configFile) sources.push([config.configFile, []])
		for (const file of config.configFileDependencies) sources.push([file, []])
		for (const file of project.config.globalSetup) {
			sources.push([file, config.resolve.alias])
		}
	}
	for (const [file, aliases] of sources) {
		// A config or globalSetup file that is itself part of an installed package.
		const installed = packageDir(file)
		if (installed === null) queue.push(...importedPackages(file, aliases))
		else queue.push(installed)
	}
	const seen = new Set<string>()
	const found = new Set<string>()
	while (queue.length > 0) {
		const dir = queue.pop()
		if (dir === undefined) continue
		let real: string
		try {
			real = realpathSync(dir)
		} catch {
			continue
		}
		// pnpm: the link that led here, which may come to lead to another version.
		const link = dir === real ? null : relative(repo, dir)
		if (link !== null && packageDir(dir) !== null) found.add(link)
		if (seen.has(real)) continue
		seen.add(real)
		const inRepo = relative(repo, real)
		if (inRepo !== null && packageDir(real) !== null) found.add(inRepo)
		let manifest: Record<string, Record<string, string> | undefined>
		try {
			manifest = JSON.parse(
				readFileSync(path.join(real, 'package.json'), 'utf8'),
			) as typeof manifest
		} catch {
			continue
		}
		for (const field of [
			'dependencies',
			'optionalDependencies',
			'peerDependencies',
		]) {
			for (const name of Object.keys(manifest[field] ?? {})) {
				const next = findPackage(real, name)
				if (next) queue.push(next)
			}
		}
	}
	return [...found].sort()
}

/** The packages the test files of one run loaded, repository-relative. */
export interface RunPackages {
	/** Test file → the package directories it loaded, with the links that led to them. */
	files: Map<string, string[]>
	/** Test files whose list misses packages (a browser project ran them, or the Node could not see ES module loads): they rerun with the lockfile too. */
	incomplete: Set<string>
	/** Packages the run itself loads: a change reruns everything. */
	global: string[]
}

/**
 * What the workers left under `recordRoot` for the test files of this run.
 * A test file two projects ran has the packages of both. `bundled` are the
 * test files a browser project ran.
 */
export async function collectPackages(
	vitest: Vitest,
	repo: string,
	recordRoot: string | undefined,
	bundled: readonly string[],
): Promise<RunPackages> {
	const fresh = new Map<string, Set<string>>()
	const importers = new Map<string, Set<string>>()
	const links = new PackageLinks(repo)
	const incomplete = new Set<string>()
	for (const file of bundled) {
		const test = relative(repo, file)
		if (test !== null) incomplete.add(test)
	}
	const pieces = recordRoot ? path.join(recordRoot, 'deps') : null
	let names: string[] = []
	try {
		if (pieces) names = await readdir(pieces)
	} catch {}
	for (const name of names) {
		if (!name.endsWith(PACKAGES_SUFFIX) || !pieces) continue
		const file = path.join(pieces, name)
		try {
			const piece = JSON.parse(await readFile(file, 'utf8')) as {
				test: string
				packages: string[]
				dirs?: string[]
				incomplete?: boolean
			}
			const test = relative(repo, piece.test)
			if (test !== null) {
				if (piece.incomplete) incomplete.add(test)
				let dirs = fresh.get(test)
				if (!dirs) fresh.set(test, (dirs = new Set()))
				for (const loaded of piece.packages) {
					const inRepo = relative(repo, loaded)
					if (inRepo !== null) dirs.add(inRepo)
				}
				let from = importers.get(test)
				if (!from) importers.set(test, (from = new Set([test])))
				for (const importer of piece.dirs ?? []) {
					const inRepo = relative(repo, importer)
					if (inRepo !== null) from.add(`${inRepo}/.`)
				}
			}
		} catch {}
		await rm(file, { force: true })
	}
	const files = new Map<string, string[]>()
	// pnpm: a test also depends on the links that led to its packages.
	for (const [test, dirs] of fresh) files.set(test, links.expand(dirs, importers.get(test)))
	const roots: string[] = []
	for (const project of [vitest.getRootProject(), ...vitest.projects]) {
		const root = relative(repo, project.config.root)
		if (root !== null) roots.push(`${root}/.`)
	}
	return { files, incomplete, global: links.expand(globalPackages(vitest, repo), roots) }
}
