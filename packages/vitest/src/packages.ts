import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Vitest } from 'vitest/node'

import { PACKAGES_SUFFIX } from '../../shared/src/fs-recorder.ts'
import { packageDir } from '../../shared/src/packages.ts'

/**
 * The installed packages each test file loaded. Vitest's own record ends at
 * `node_modules`, so this one is kept beside it: an install then reruns the
 * test files that loaded a package whose version changed, not every one.
 */
export const PACKAGES_FILE = 'blacksmith-packages.json'
const PACKAGES_VERSION = 1

export interface PackageRecords {
	version: number
	/** Repository-relative test file → the package directories it loaded, repository-relative. */
	files: Record<string, string[]>
	/** Packages the run itself loads (Vitest, Vite, what the config files import, and what those depend on): a change reruns everything. */
	global: string[]
}

function relative(repo: string, file: string): string | null {
	const result = path.relative(repo, file)
	if (result === '' || result.startsWith('..') || path.isAbsolute(result)) {
		return null
	}
	return result.split(path.sep).join('/')
}

export async function readPackages(dir: string): Promise<PackageRecords | null> {
	try {
		const records = JSON.parse(
			await readFile(path.join(dir, PACKAGES_FILE), 'utf8'),
		) as PackageRecords
		return records.version === PACKAGES_VERSION ? records : null
	} catch {
		return null
	}
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

/** The packages the source file `file` names in its imports. */
function importedPackages(file: string): string[] {
	let source: string
	try {
		source = readFileSync(file, 'utf8')
	} catch {
		return []
	}
	const found: string[] = []
	for (const [, specifier] of source.matchAll(SPECIFIER)) {
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
	const sources = new Set<string>()
	for (const project of [vitest.getRootProject(), ...vitest.projects]) {
		const config = project.vite.config
		if (config.configFile) sources.add(config.configFile)
		for (const file of config.configFileDependencies) sources.add(file)
		for (const file of project.config.globalSetup) sources.add(file)
	}
	for (const file of sources) {
		if (packageDir(file) === null) queue.push(...importedPackages(file))
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

/**
 * Merges what the workers left under `recordRoot` for the test files of this
 * run into the record in `dir`. A test file two projects ran keeps the
 * packages of both; one that no longer exists is dropped.
 */
export async function updatePackages(
	vitest: Vitest,
	repo: string,
	dir: string,
	recordRoot: string | undefined,
): Promise<void> {
	const records = (await readPackages(dir)) ?? {
		version: PACKAGES_VERSION,
		files: {},
		global: [],
	}
	const fresh = new Map<string, Set<string>>()
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
			}
			const test = relative(repo, piece.test)
			if (test !== null) {
				let dirs = fresh.get(test)
				if (!dirs) fresh.set(test, (dirs = new Set()))
				for (const loaded of piece.packages) {
					const inRepo = relative(repo, loaded)
					if (inRepo !== null) dirs.add(inRepo)
				}
			}
		} catch {}
		await rm(file, { force: true })
	}
	for (const [test, dirs] of fresh) records.files[test] = [...dirs].sort()
	for (const test of Object.keys(records.files)) {
		if (!existsSync(path.join(repo, test))) delete records.files[test]
	}
	records.global = globalPackages(vitest, repo)
	await mkdir(dir, { recursive: true })
	const file = path.join(dir, PACKAGES_FILE)
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	await writeFile(tmp, JSON.stringify(records))
	await rename(tmp, file)
}
