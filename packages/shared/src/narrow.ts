import type { Digest } from './units.ts'

/**
 * A module's digest with every specifier replaced by what it resolved to: a
 * repo-relative file, or `?specifier` for a package or anything else that is
 * not a file of the repository.
 */
export interface ResolvedDigest extends Digest {
	/** Specifier → what it resolved to, for resolving the same module's next version. */
	specifiers: Record<string, string>
}

export function resolveDigest(
	digest: Digest,
	specifiers: Record<string, string>,
): ResolvedDigest {
	const to = (specifier: string) => specifiers[specifier] ?? `?${specifier}`
	return {
		...digest,
		reexports: Object.fromEntries(
			Object.entries(digest.reexports).map(([name, [specifier, imported]]) => [
				name,
				[to(specifier), imported],
			]),
		),
		stars: digest.stars.map(to),
		imports: digest.imports.map(([specifier, names]) => [to(specifier), names]),
		sources: [...new Set(digest.sources.map(to))],
		specifiers,
	}
}

/** What a changed module's difference comes down to. */
type Change =
	/** Every test that loaded the module. */
	| 'all'
	| {
			/** Functions whose body changed: the tests that entered one. */
			functions: Set<string>
			/** Exported names whose value changed: the tests that loaded a module importing one. */
			values: Set<string>
			/** Modules it started or stopped loading. */
			added: string[]
			removed: string[]
	  }

function same(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

/** `null` when the two versions run the same code. */
export function difference(before: ResolvedDigest, after: ResolvedDigest): Change | null {
	if (before.rest !== after.rest || before.wild !== after.wild) return 'all'
	if (!same(before.stars, after.stars)) return 'all'
	// Declarations are evaluated in order; one moved past another may see it
	// unset, a function held in a `const` included.
	const order = (digest: Digest, other: Digest) =>
		Object.keys(digest.units).filter((name) => Object.hasOwn(other.units, name))
	if (!same(order(before, after), order(after, before))) return 'all'

	const functions = new Set<string>()
	const locals = new Set<string>()
	for (const name of new Set([...Object.keys(before.units), ...Object.keys(after.units)])) {
		const old = before.units[name]
		const now = after.units[name]
		if (!old || !now || old.kind !== now.kind || old.sig !== now.sig) locals.add(name)
		else if (old.body !== now.body) (old.kind === 'f' ? functions : locals).add(name)
	}
	// A value built from a changed one changed too; a function that reads a
	// changed one behaves differently once called.
	for (let grew = true; grew; ) {
		grew = false
		for (const digest of [before, after]) {
			for (const [name, unit] of Object.entries(digest.units)) {
				const target = unit.kind === 'f' ? functions : locals
				if (target.has(name) || locals.has(name)) continue
				if (unit.refs.some((ref) => locals.has(ref))) {
					target.add(name)
					grew = true
				}
			}
		}
	}
	for (const digest of [before, after]) {
		if (digest.restRefs.some((ref) => locals.has(ref))) return 'all'
	}
	const values = new Set<string>()
	const exported = new Set([...Object.keys(before.exports), ...Object.keys(after.exports)])
	for (const name of exported) {
		const old = before.exports[name]
		const now = after.exports[name]
		if (old !== now || (old !== undefined && locals.has(old))) values.add(name)
	}
	const reexported = new Set([...Object.keys(before.reexports), ...Object.keys(after.reexports)])
	for (const name of reexported) {
		const old = before.reexports[name]
		const now = after.reexports[name]
		if (!old || !now || old[0] !== now[0] || old[1] !== now[1]) values.add(name)
	}
	const added = after.sources.filter((source) => !before.sources.includes(source))
	const removed = before.sources.filter((source) => !after.sources.includes(source))
	if (functions.size + values.size + added.length + removed.length === 0) return null
	return { functions, values, added, removed }
}

export interface RecordedTest {
	/** Repo-relative files the test loaded. */
	deps: ReadonlySet<string>
	/** Loaded module → the functions entered in it; a module missing here was not watched. */
	ran: Readonly<Record<string, readonly string[]>> | undefined
}

const CODE = /\.[cm]?[jt]sx?$/

/**
 * Decides, for the changed files a test loaded, whether any of them changed
 * something the test ran or read. `modules` are the digests the tests ran
 * against, `current` the changed files' digests now (`null`: not analysable).
 */
export class Narrowing {
	readonly #modules: Readonly<Record<string, ResolvedDigest>>
	readonly #changes = new Map<string, Change | null>()
	/** Module → the modules that import bindings from it, with the names. */
	readonly #importers = new Map<string, Array<[module: string, names: readonly string[] | '*']>>()
	/** Module → the modules that pass its exports on. */
	readonly #barrels = new Map<string, Array<[module: string, exported: string, name: string]>>()
	readonly #stars = new Map<string, string[]>()
	/** Module → every module that loads it statically. */
	readonly #loaders = new Map<string, Set<string>>()
	readonly #wild = new Set<string>()
	readonly #reached = new Map<string, Map<string, Set<string>>>()

	constructor(
		modules: Readonly<Record<string, ResolvedDigest>>,
		changed: ReadonlyMap<string, ResolvedDigest | null>,
	) {
		this.#modules = modules
		const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
			const list = map.get(key)
			if (list) list.push(value)
			else map.set(key, [value])
		}
		for (const [module, digest] of Object.entries(modules)) {
			if (digest.wild) this.#wild.add(module)
			for (const [source, names] of digest.imports) push(this.#importers, source, [module, names])
			for (const [exported, [source, name]] of Object.entries(digest.reexports)) {
				push(this.#barrels, source, [module, exported, name])
			}
			for (const source of digest.stars) push(this.#stars, source, module)
			for (const source of digest.sources) {
				const loaders = this.#loaders.get(source)
				if (loaders) loaders.add(module)
				else this.#loaders.set(source, new Set([module]))
			}
		}
		for (const [file, after] of changed) {
			const before = modules[file]
			this.#changes.set(file, before && after ? difference(before, after) : 'all')
		}
	}

	/** Whether `file`'s change reaches no test at all, or only some. */
	narrowable(file: string): boolean {
		return this.#changes.has(file) && this.#changes.get(file) !== 'all'
	}

	/** Every module a change to `values` of `file` shows through, with the names it shows as there. */
	#reach(file: string, values: ReadonlySet<string>): Map<string, Set<string>> {
		const cached = this.#reached.get(file)
		if (cached) return cached
		const reached = new Map<string, Set<string>>([[file, new Set(values)]])
		const queue: Array<[string, string]> = [...values].map((name) => [file, name])
		const add = (module: string, name: string) => {
			let names = reached.get(module)
			if (!names) reached.set(module, (names = new Set()))
			if (names.has(name)) return
			names.add(name)
			queue.push([module, name])
		}
		for (let next = queue.pop(); next; next = queue.pop()) {
			const [module, name] = next
			for (const [barrel, exported, imported] of this.#barrels.get(module) ?? []) {
				if (imported === name || imported === '*') add(barrel, exported)
			}
			if (name === 'default') continue
			for (const barrel of this.#stars.get(module) ?? []) add(barrel, name)
		}
		this.#reached.set(file, reached)
		return reached
	}

	/** Whether the change to `file` can alter what `test` does. */
	affects(file: string, test: RecordedTest): boolean {
		const change = this.#changes.get(file)
		if (change === null) return false
		if (change === undefined || change === 'all') return true
		const ran = test.ran?.[file]
		if (!ran) return true
		if (ran.some((name) => change.functions.has(name))) return true
		const loadedOtherwise = (source: string): boolean => {
			if (test.deps.has(source)) return true
			for (const loader of this.#loaders.get(source) ?? []) {
				if (loader !== file && test.deps.has(loader)) return true
			}
			return false
		}
		// A module it now loads may run code the test never has, and one it
		// no longer loads is gone from the test unless another still loads it.
		for (const source of change.added) if (!loadedOtherwise(source)) return true
		for (const source of change.removed) {
			let kept = false
			for (const loader of this.#loaders.get(source) ?? []) {
				if (loader !== file && test.deps.has(loader)) kept = true
			}
			if (!kept) return true
		}
		if (change.values.size === 0) return false
		// Loaded some way the import graph does not show: whatever took it
		// may have read any of its values.
		let explained = false
		for (const loader of this.#loaders.get(file) ?? []) {
			if (test.deps.has(loader)) explained = true
		}
		if (!explained) return true
		for (const dep of test.deps) {
			if (this.#wild.has(dep)) return true
			// A script that ran without being analysed may have read anything.
			if (!this.#modules[dep] && CODE.test(dep) && !dep.includes('node_modules/')) {
				return true
			}
		}
		for (const [module, names] of this.#reach(file, change.values)) {
			if (module !== file && !test.deps.has(module)) continue
			for (const [importer, taken] of this.#importers.get(module) ?? []) {
				if (!test.deps.has(importer)) continue
				if (taken === '*' || taken.some((name) => names.has(name))) return true
			}
		}
		return false
	}
}
