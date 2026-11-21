import type { Digest, Unit } from './units.ts'

/**
 * A module's digest with every specifier replaced by what it resolved to: a
 * repo-relative file, or `?specifier` for a package or anything else that is
 * not a file of the repository.
 */
export interface ResolvedDigest extends Digest {
	/** Specifier → what it resolved to, for resolving the same module's next version. */
	specifiers: Record<string, string>
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

export function resolveDigest(
	digest: Digest,
	specifiers: Record<string, string>,
): ResolvedDigest {
	const to = (specifier: string) => specifiers[specifier] ?? `?${specifier}`
	// Two specifiers may name one module, and each calls a name its own way.
	let aliases: Record<string, Record<string, string[]>> | undefined
	if (digest.aliases) {
		const locals = new Map<string, Set<string>>()
		for (const [specifier, names] of digest.imports) {
			if (names === '*') continue
			const given = own(digest.aliases, specifier)
			for (const name of names) {
				const id = `${to(specifier)}\0${name}`
				let list = locals.get(id)
				if (!list) locals.set(id, (list = new Set()))
				for (const local of (given ? own(given, name) : undefined) ?? [name]) list.add(local)
			}
		}
		for (const [id, list] of locals) {
			const [module, name] = id.split('\0') as [string, string]
			if (list.size === 1 && list.has(name)) continue
			;((aliases ??= {})[module] ??= {})[name] = [...list].sort()
		}
	}
	return {
		...digest,
		...(aliases ? { aliases } : {}),
		reexports: Object.fromEntries(
			Object.entries(digest.reexports).map(([name, [specifier, imported]]) => [
				name,
				[to(specifier), imported],
			]),
		),
		stars: digest.stars.map(to),
		imports: digest.imports.map(([specifier, names]) => [to(specifier), names]),
		sources: [...new Set(digest.sources.map(to))],
		linked: new Set(digest.sources.slice(0, digest.linked).map(to)).size,
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
			/**
			 * Those of `values` that hold an object literal of which only these keys
			 * changed: the tests that loaded a module reading one, or using the object whole.
			 */
			keys: Map<string, ReadonlySet<string>>
			/** Modules it started or stopped loading. */
			added: string[]
			removed: string[]
	  }

function same(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

/** `null` when the two versions run the same code. */
export function difference(before: ResolvedDigest, after: ResolvedDigest): Change | null {
	if (before.opaque || after.opaque) return 'all'
	if (before.rest !== after.rest || before.wild !== after.wild) return 'all'
	if (!same(before.stars, after.stars)) return 'all'
	// Declarations are evaluated in order; one moved past another may see it
	// unset, a function held in a `const` included.
	const order = (digest: Digest, other: Digest) =>
		Object.keys(digest.units).filter((name) => Object.hasOwn(other.units, name))
	if (!same(order(before, after), order(after, before))) return 'all'
	// So are the modules a file imports, and what they do as they load.
	const linked = (digest: Digest, other: Digest) =>
		digest.sources
			.slice(0, digest.linked)
			.filter((source) => other.sources.slice(0, other.linked).includes(source))
	if (!same(linked(before, after), linked(after, before))) return 'all'
	// A module a function used to load lazily and the file now loads itself,
	// or the reverse, loads at another time for every test.
	const lazy = (digest: Digest) => new Set(digest.sources.slice(digest.linked))
	for (const [digest, other] of [
		[before, after],
		[after, before],
	] as const) {
		const late = lazy(other)
		if (digest.sources.slice(0, digest.linked).some((source) => late.has(source))) return 'all'
	}

	const functions = new Set<string>()
	const locals = new Set<string>()
	/** Object literals of which only some keys changed, with those keys. */
	const partial = new Map<string, ReadonlySet<string>>()
	for (const name of new Set([...Object.keys(before.units), ...Object.keys(after.units)])) {
		const old = before.units[name]
		const now = after.units[name]
		if (!old || !now || old.kind !== now.kind || old.sig !== now.sig) locals.add(name)
		else if (old.body !== now.body) {
			const keys = old.kind === 'v' ? changedKeys(old, now) : null
			// The same keys with the same values in the same order: only the space between them differs.
			if (keys?.size === 0) continue
			if (keys) partial.set(name, keys)
			else (old.kind === 'f' ? functions : locals).add(name)
		}
	}
	// What reads a changed name: all of it, or one of the keys that changed.
	const reads = (refs: readonly string[], read: Readonly<Record<string, string[]>> | undefined) =>
		refs.some((ref) => {
			if (locals.has(ref)) return true
			const keys = partial.get(ref)
			if (!keys) return false
			const taken = read ? own(read, ref) : undefined
			return !taken || taken.some((key) => keys.has(key))
		})
	// A value built from a changed one changed too; a function that reads a
	// changed one behaves differently once called.
	for (let grew = true; grew; ) {
		grew = false
		for (const digest of [before, after]) {
			for (const [name, unit] of Object.entries(digest.units)) {
				const target = unit.kind === 'f' ? functions : locals
				if (target.has(name) || locals.has(name)) continue
				if (reads(unit.refs, unit.reads)) {
					target.add(name)
					grew = true
				}
			}
		}
	}
	for (const digest of [before, after]) {
		if (reads(digest.restRefs, digest.restReads)) return 'all'
		// A changed value, or one built from it, that may do more than make the
		// value did so for every test that loaded the module.
		for (const name of [...locals, ...partial.keys()]) {
			if (Object.hasOwn(digest.units, name) && digest.units[name]!.effects) return 'all'
		}
	}
	const values = new Set<string>()
	const keys = new Map<string, ReadonlySet<string>>()
	const exported = new Set([...Object.keys(before.exports), ...Object.keys(after.exports)])
	for (const name of exported) {
		const old = before.exports[name]
		const now = after.exports[name]
		if (old !== now || (old !== undefined && locals.has(old))) values.add(name)
		else if (old !== undefined && partial.has(old)) {
			values.add(name)
			keys.set(name, partial.get(old)!)
		}
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
	return { functions, values, keys, added, removed }
}

/**
 * The keys that differ between two versions of a `const` holding an object
 * literal; `null` when more than its keys changed. Values are evaluated in
 * order, so keys that changed places may each hold another value.
 */
function changedKeys(old: Unit, now: Unit): Set<string> | null {
	if (!old.keys || !now.keys || old.frame !== now.frame) return null
	const kept = (unit: Unit, other: Unit) => Object.keys(unit.keys!).filter((key) => Object.hasOwn(other.keys!, key))
	if (!same(kept(old, now), kept(now, old))) return null
	const changed = new Set<string>()
	for (const key of new Set([...Object.keys(old.keys), ...Object.keys(now.keys)])) {
		if (own(old.keys, key) !== own(now.keys, key)) changed.add(key)
	}
	return changed
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
	/** File → module → name → the keys that changed under it, `null` for the whole value. */
	readonly #reached = new Map<string, Map<string, Map<string, ReadonlySet<string> | null>>>()

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
	#reach(
		file: string,
		values: ReadonlySet<string>,
		keys: ReadonlyMap<string, ReadonlySet<string>>,
	): Map<string, Map<string, ReadonlySet<string> | null>> {
		const cached = this.#reached.get(file)
		if (cached) return cached
		const reached = new Map<string, Map<string, ReadonlySet<string> | null>>()
		const queue: Array<[string, string]> = []
		const add = (module: string, name: string, changed: ReadonlySet<string> | null) => {
			let names = reached.get(module)
			if (!names) reached.set(module, (names = new Map()))
			const had = names.get(name)
			if (had === null) return
			if (had && changed && [...changed].every((key) => had.has(key))) return
			names.set(name, changed && had ? new Set([...had, ...changed]) : changed)
			queue.push([module, name])
		}
		for (const name of values) add(file, name, keys.get(name) ?? null)
		for (let next = queue.pop(); next; next = queue.pop()) {
			const [module, name] = next
			const changed = reached.get(module)!.get(name) ?? null
			for (const [barrel, exported, imported] of this.#barrels.get(module) ?? []) {
				if (imported === name) add(barrel, exported, changed)
				// A namespace holds the value under a key of its own.
				else if (imported === '*') add(barrel, exported, null)
			}
			if (name === 'default') continue
			for (const barrel of this.#stars.get(module) ?? []) add(barrel, name, changed)
		}
		this.#reached.set(file, reached)
		return reached
	}

	/**
	 * Whether `test` ran something of `importer` that reads one of the `changed`
	 * keys of the object it imports as `name` from `module`, or uses the object
	 * whole. A function reads when it is called; anything else when the module loads.
	 */
	#reads(
		importer: string,
		module: string,
		name: string,
		changed: ReadonlySet<string>,
		test: RecordedTest,
	): boolean {
		const digest = this.#modules[importer]
		if (!digest) return true
		// A module that was not watched may have run any of its functions.
		const entered = test.ran?.[importer]
		const given = own(digest.aliases ?? {}, module)
		const touches = (read: Readonly<Record<string, string[]>> | undefined, local: string) => {
			const keys = read ? own(read, local) : undefined
			return !keys || keys.some((key) => changed.has(key))
		}
		for (const local of (given ? own(given, name) : undefined) ?? [name]) {
			// Exported again, it is read wherever it goes.
			if (Object.values(digest.exports).includes(local)) return true
			if (digest.restRefs.includes(local) && touches(digest.restReads, local)) return true
			for (const [unit, { kind, refs, reads }] of Object.entries(digest.units)) {
				if (!refs.includes(local) || !touches(reads, local)) continue
				if (kind === 'v' || !entered || entered.includes(unit)) return true
			}
		}
		return false
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
		for (const [module, names] of this.#reach(file, change.values, change.keys)) {
			if (module !== file && !test.deps.has(module)) continue
			for (const [importer, taken] of this.#importers.get(module) ?? []) {
				if (!test.deps.has(importer)) continue
				if (taken === '*') return true
				for (const name of taken) {
					const changed = names.get(name)
					if (changed === undefined) continue
					if (changed === null || this.#reads(importer, module, name, changed, test)) return true
				}
			}
		}
		return false
	}
}
