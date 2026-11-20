import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * Installed packages as dependencies. A test depends on the packages it
 * loaded, each named by its directory and vouched for by the version in its
 * package.json: a lockfile change then reruns the tests whose packages
 * changed, not every test.
 */

/** Whether `file` (absolute or repository-relative) lies in an installed package. */
export function isPackagePath(file: string): boolean {
	return file.split(/[\\/]/).includes('node_modules')
}

/** The directory of the installed package `file` belongs to, null for a file outside `node_modules`. */
export function packageDir(file: string): string | null {
	const parts = file.split(path.sep)
	const at = parts.lastIndexOf('node_modules')
	const name = parts[at + 1]
	if (at === -1 || name === undefined || name.startsWith('.')) return null
	const length = name.startsWith('@') ? at + 3 : at + 2
	return parts.length < length ? null : parts.slice(0, length).join(path.sep)
}

/** `packageDir(file)` when it lies in the repository at `repo`; packages installed elsewhere are not tracked. */
export function repositoryPackage(repo: string, file: string): string | null {
	const dir = packageDir(file)
	if (dir === null) return null
	const relative = path.relative(repo, dir)
	return relative.startsWith('..') || path.isAbsolute(relative) ? null : dir
}

/**
 * The copies of the package at `dir` in its pnpm store, when it is in one.
 * `pnpm add` leaves the old copy where it was and links a new one beside it,
 * so the copy a test loaded stays as it is while the name now leads elsewhere.
 */
function storeCopies(dir: string): string {
	const parts = dir.split(path.sep)
	const at = parts.lastIndexOf('.pnpm')
	if (at === -1 || parts[at + 2] !== 'node_modules') return ''
	const prefix = `${parts
		.slice(at + 3)
		.join('+')
		.toLowerCase()}@`
	try {
		const copies = readdirSync(parts.slice(0, at + 1).join(path.sep))
			.filter((entry) => entry.toLowerCase().startsWith(prefix))
			.sort()
		return `:${copies.join(',')}`
	} catch {
		return ''
	}
}

/** What stands in the anchor for the package installed at `dir`; null when none is. */
export function packageVersion(dir: string): string | null {
	try {
		const manifest = JSON.parse(
			readFileSync(path.join(dir, 'package.json'), 'utf8'),
		) as { version?: unknown }
		return `package:${String(manifest.version)}${storeCopies(dir)}`
	} catch {
		return null
	}
}

/** The fields of a package.json that only say which packages to install. */
const DEPENDENCY_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'peerDependenciesMeta',
	'optionalDependencies',
	'bundleDependencies',
	'bundledDependencies',
	'overrides',
	'resolutions',
]

/**
 * What stands in the anchor for the package.json at `file`: a hash of
 * everything but its dependency fields, which the installed packages answer
 * for. Null when it is missing or not JSON, and its content stands instead.
 */
export function manifestShape(file: string): string | null {
	try {
		const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<
			string,
			unknown
		>
		for (const field of DEPENDENCY_FIELDS) delete manifest[field]
		if (typeof manifest.pnpm === 'object' && manifest.pnpm !== null) {
			const { overrides: _, ...pnpm } = manifest.pnpm as Record<string, unknown>
			manifest.pnpm = pnpm
		}
		return `manifest:${createHash('sha1').update(JSON.stringify(manifest)).digest('hex')}`
	} catch {
		return null
	}
}

/**
 * What a read of the file `absolute` is recorded as: the directory of its
 * package for a file of a package installed in the repository at `repo`,
 * null for any other file.
 */
export function packageOf(
	repo: string | undefined,
	absolute: string,
): string | null {
	return repo && isPackagePath(absolute)
		? repositoryPackage(repo, absolute)
		: null
}

/**
 * Whether the file read under way was made while a module loads, by the
 * runner's resolver or a transformer, and not by code a test called: walking
 * up from the call, a frame `loader` accepts comes before any frame of the
 * repository. A read with no caller left on the stack (made from a callback
 * or a promise) counts as the test's, which only reruns more.
 */
export function readDuringLoad(
	own: (line: string) => boolean,
	loader: (line: string) => boolean,
): boolean {
	for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
		if (own(line)) continue
		if (loader(line)) return true
		if (line.includes('node:') || !/[\\/]/.test(line)) continue
		if (!isPackagePath(line)) return false
	}
	return false
}
