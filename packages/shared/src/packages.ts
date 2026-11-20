import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Installed packages as dependencies. A test depends on the packages it
 * loaded, each named by its directory and vouched for by the version in its
 * package.json: a lockfile change then reruns the tests whose packages
 * changed, not every test.
 */

/**
 * Where the last `node_modules` segment of `file` starts, -1 without one;
 * segments end at `sep`, or at either separator when it is not given. Called
 * for every module resolved and file read, in workers too short-lived for
 * their code to be optimised: no array is built.
 */
function lastPackagesSegment(file: string, sep?: string): number {
	for (
		let at = file.lastIndexOf('node_modules');
		at !== -1;
		at = at === 0 ? -1 : file.lastIndexOf('node_modules', at - 1)
	) {
		const before = at === 0 ? undefined : file[at - 1]
		const after = file[at + 12]
		if (
			(before === undefined || isSeparator(before, sep)) &&
			(after === undefined || isSeparator(after, sep))
		) {
			return at
		}
	}
	return -1
}

function isSeparator(character: string, sep?: string): boolean {
	return sep === undefined
		? character === '/' || character === '\\'
		: character === sep
}

/** Whether `file` (absolute or repository-relative) lies in an installed package. */
export function isPackagePath(file: string): boolean {
	return lastPackagesSegment(file) !== -1
}

/** Whether a segment of `file`, split at `sep`, is `node_modules`. */
export function inPackages(file: string, sep: string = path.sep): boolean {
	return lastPackagesSegment(file, sep) !== -1
}

/** The directory of the installed package `file` belongs to, null for a file outside `node_modules`; `sep` separates its segments. */
export function packageDir(file: string, sep: string = path.sep): string | null {
	const at = lastPackagesSegment(file, sep)
	if (at === -1 || at + 12 === file.length) return null
	const start = at + 13
	const end = file.indexOf(sep, start)
	if (file[start] === '.') return null
	if (file[start] !== '@') return end === -1 ? file : file.slice(0, end)
	if (end === -1) return null
	const scoped = file.indexOf(sep, end + 1)
	return scoped === -1 ? file : file.slice(0, scoped)
}

/** `packageDir(file)` when it lies in the repository at `repo`; packages installed elsewhere are not tracked. */
export function repositoryPackage(repo: string, file: string): string | null {
	const dir = packageDir(file)
	if (dir === null) return null
	// Called for every file read: the plain prefix check spares `path.relative` its work.
	if (dir.startsWith(repo + path.sep) && !dir.includes('..')) return dir
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
	private readonly manifests = new Map<string, boolean>()

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
				const to = real.split(path.sep).join('/')
				// Whatever the entry is called: a symbolic link, or a junction on Windows.
				if (to !== link && !real.startsWith('..') && !path.isAbsolute(real)) {
					links.set(link, to)
				}
			} catch {}
		}
		for (const entry of entries(base)) {
			if (entry.name.startsWith('.')) continue
			const at = `${base}/${entry.name}`
			if (entry.name.startsWith('@') && !entry.isSymbolicLink()) {
				for (const scoped of entries(at)) add(`${at}/${scoped.name}`)
			} else add(at)
		}
		return links
	}

	/** Whether the repository directory `dir` (`.` for its root) holds a package.json, as a directory packages are installed beside does. */
	private manifest(dir: string): boolean {
		let known = this.manifests.get(dir)
		if (known === undefined) {
			known = existsSync(path.join(this.root, dir, 'package.json'))
			this.manifests.set(dir, known)
		}
		return known
	}

	/**
	 * `paths` (repository-relative files and package directories) with the
	 * links that lead to its packages: those beside the packages it holds and
	 * beside the packages in `files`, and those in the node_modules
	 * directories above its files and above the other `files`.
	 *
	 * And with the node_modules directories a copy installed later would be
	 * found in first: one between a file, or a package, and a package found
	 * further up. Such a directory stands by the names installed in it.
	 */
	expand(paths: Iterable<string>, files: Iterable<string> = []): string[] {
		const all = new Set(paths)
		const packages = [...all].filter(isPackagePath)
		if (packages.length === 0) return [...all].sort()
		const bases = new Set<string>()
		// Directories a package is looked up from, nearest first: `.` is the repository's.
		const above = new Set<string>()
		const climb = (from: string) => {
			let dir = from
			while (true) {
				if (above.has(dir)) break
				above.add(dir)
				if (dir === '.' || dir === '/') break
				dir = path.posix.dirname(dir)
			}
		}
		if (packages.some((dir) => STORE_ENTRY.test(dir))) {
			const importers = [...files].filter(isPackagePath)
			for (const dir of [...packages, ...importers]) {
				const entry = STORE_ENTRY.exec(dir)
				if (!entry) continue
				bases.add(entry[0])
				bases.add(`${entry[1]}/.pnpm/node_modules`)
				bases.add(entry[1] as string)
			}
		}
		for (const file of [...all, ...files]) {
			if (!isPackagePath(file)) climb(path.posix.dirname(file))
		}
		for (const dir of above) {
			bases.add(dir === '.' ? 'node_modules' : `${dir}/node_modules`)
		}
		if (bases.size > 0 && packages.some((dir) => STORE_ENTRY.test(dir))) {
			for (const base of bases) {
				for (const [link, real] of this.list(base)) {
					if (all.has(real)) all.add(link)
				}
			}
		}
		// Where each package was found: the directory its node_modules is in, with the names found there.
		const found = new Map<string, string[]>()
		for (const dir of all) {
			if (!isPackagePath(dir) || STORE_ENTRY.test(dir)) continue
			const at = dir.lastIndexOf('/node_modules/')
			const base = at === -1 ? '.' : dir.slice(0, at)
			const name = dir.slice(dir.lastIndexOf('node_modules/') + 13)
			if (dir.endsWith('/node_modules') || dir === 'node_modules') continue
			let names = found.get(base)
			if (!names) found.set(base, (names = []))
			names.push(name)
			// A package installed in a workspace looks further up from there.
			if (!isPackagePath(base)) climb(base)
		}
		for (const dir of above) {
			if (dir === '.' || !this.manifest(dir)) continue
			const modules = `${dir}/node_modules`
			for (const [base, names] of found) {
				if (base !== '.' && !dir.startsWith(`${base}/`)) continue
				if (names.some((name) => !all.has(`${modules}/${name}`))) {
					all.add(modules)
					break
				}
			}
		}
		return [...all].sort()
	}
}

/** The names of the packages installed in the node_modules directory `dir`; null when there is none. */
function installed(dir: string): string | null {
	const names: string[] = []
	const entries = (at: string): string[] => {
		try {
			return readdirSync(at)
		} catch {
			return []
		}
	}
	for (const name of entries(dir)) {
		if (name.startsWith('.')) continue
		if (!name.startsWith('@')) names.push(name)
		else for (const scoped of entries(path.join(dir, name))) names.push(`${name}/${scoped}`)
	}
	if (names.length === 0) return null
	return createHash('sha1').update(names.sort().join('\0')).digest('hex')
}

/** The pnpm store entry behind the link at `dir`, so that another build of one version (other peers) is another package. */
function storeEntry(dir: string): string {
	try {
		const real = realpathSync(dir)
		if (real === path.resolve(dir)) return ''
		const entry = STORE_ENTRY.exec(real.split(path.sep).join('/'))
		return entry ? `:${path.posix.basename(path.posix.dirname(entry[0]))}` : ''
	} catch {
		return ''
	}
}

/**
 * What stands in the anchor for the package installed at `dir`: its version,
 * and the names of the packages installed inside it, which it loads before
 * any copy further up. For a node_modules directory, the names installed in
 * it. Null when nothing is installed there.
 */
export function packageVersion(dir: string): string | null {
	if (path.basename(dir) === 'node_modules') {
		const names = installed(dir)
		return names === null ? null : `packages:${names}`
	}
	try {
		const manifest = JSON.parse(
			readFileSync(path.join(dir, 'package.json'), 'utf8'),
		) as { version?: unknown }
		const inside = installed(path.join(dir, 'node_modules'))
		return `package:${String(manifest.version)}${storeEntry(dir)}${inside === null ? '' : `+${inside}`}`
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
	return repo ? repositoryPackage(repo, absolute) : null
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
