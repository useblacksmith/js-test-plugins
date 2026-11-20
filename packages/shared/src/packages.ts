import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
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

/** The node_modules directory a pnpm store entry keeps its package and that package's dependencies in. */
const STORE_ENTRY = /^((?:.*\/)?node_modules)\/\.pnpm\/[^/]+\/node_modules(?=\/)/

/**
 * The links that lead to installed packages. pnpm keeps each version of a
 * package in a directory of its own and links to it by name, so the
 * directory a test loaded a package from stays as it is when the name is
 * made to lead to another version. A test therefore also depends on the
 * names that led to its packages: the version found behind each is compared.
 */
export class PackageLinks {
	private readonly root: string
	private readonly listed = new Map<string, Map<string, string>>()

	constructor(repo: string) {
		try {
			this.root = realpathSync(repo)
		} catch {
			this.root = repo
		}
	}

	/** The links in the node_modules directory `base`, each with the directory it leads to; both repository-relative. */
	private list(base: string): Map<string, string> {
		let links = this.listed.get(base)
		if (links) return links
		links = new Map()
		this.listed.set(base, links)
		const entries = (dir: string) => {
			try {
				return readdirSync(path.join(this.root, dir), { withFileTypes: true })
			} catch {
				return []
			}
		}
		const add = (link: string) => {
			try {
				const real = path.relative(
					this.root,
					realpathSync(path.join(this.root, link)),
				)
				if (!real.startsWith('..') && !path.isAbsolute(real)) {
					links.set(link, real.split(path.sep).join('/'))
				}
			} catch {}
		}
		for (const entry of entries(base)) {
			if (entry.name.startsWith('.')) continue
			const at = `${base}/${entry.name}`
			if (entry.isSymbolicLink()) add(at)
			else if (entry.name.startsWith('@')) {
				for (const scoped of entries(at)) {
					if (scoped.isSymbolicLink()) add(`${at}/${scoped.name}`)
				}
			}
		}
		return links
	}

	/**
	 * `paths` (repository-relative files and package directories) with the
	 * links that lead to its packages: those beside the packages it holds, and
	 * those in the node_modules directories above its files and above `files`.
	 */
	expand(paths: Iterable<string>, files: Iterable<string> = []): string[] {
		const all = new Set(paths)
		const packages = [...all].filter(isPackagePath)
		if (!packages.some((dir) => STORE_ENTRY.test(dir))) return [...all].sort()
		const bases = new Set<string>()
		for (const dir of packages) {
			const entry = STORE_ENTRY.exec(dir)
			if (!entry) continue
			bases.add(entry[0])
			bases.add(`${entry[1]}/.pnpm/node_modules`)
			bases.add(entry[1] as string)
		}
		for (const file of [...all, ...files]) {
			if (isPackagePath(file)) continue
			let dir = path.posix.dirname(file)
			while (true) {
				bases.add(dir === '.' ? 'node_modules' : `${dir}/node_modules`)
				if (dir === '.' || dir === '/') break
				dir = path.posix.dirname(dir)
			}
		}
		for (const base of bases) {
			for (const [link, real] of this.list(base)) {
				if (all.has(real)) all.add(link)
			}
		}
		return [...all].sort()
	}
}

/** The pnpm store entry behind the link at `dir`, so that another build of one version (other peers) is another package. */
function storeEntry(dir: string): string {
	try {
		if (!lstatSync(dir).isSymbolicLink()) return ''
		const entry = STORE_ENTRY.exec(realpathSync(dir).split(path.sep).join('/'))
		return entry ? `:${path.posix.basename(path.posix.dirname(entry[0]))}` : ''
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
		return `package:${String(manifest.version)}${storeEntry(dir)}`
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
