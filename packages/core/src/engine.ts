import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

import {
	alwaysPaths,
	changedSince,
	currentTree,
	jobId,
	runtimeId,
	toRelative,
	type Anchor,
	type Scope,
} from './anchor.ts'
import { headSha } from './git.ts'
import { PackageLinks, isPackagePath } from './packages.ts'
import {
	emptyRecords,
	readManifests,
	recordedPaths,
	specPath,
	specProject,
	vouched,
	type Records,
	type RunRecord,
} from './record.ts'
import {
	compileRules,
	dropStale,
	mergeRecords,
	select,
	type Affects,
	type Decision,
	type Options,
	type Policy,
	type Rules,
} from './select.ts'
import { Store, type Entry, type Shard } from './store.ts'
import {
	affecting,
	dropUnits,
	mergeUnits,
	updateUnits,
	type Digester,
	type Entered,
} from './unitstore.ts'

/**
 * Test selection, whatever runs the tests. A plugin tells the session which
 * test files its runner is about to run (`plan`), runs the ones the answer
 * names, and hands back what they loaded and how they ended (`commit`).
 * Everything between is here: the record, the anchor, the Actions cache,
 * the rules. A plugin holds nothing but its runner's API.
 */
export interface Runner {
	/** `jest`, `mocha`, `vitest`. */
	name: string
	repo: string
	/** Where the runner runs, absolute. */
	cwd: string
	/** The data directory. */
	dir: string
	options: Options
	/** Names of the runner's config files, looked for in `cwd` and at the repository root: a change to one runs everything. */
	always: readonly string[]
	/** The directory the globs of `options` are relative to, absolute; the repository root when left out. */
	rulesBase?: string
	/** What part of the suite the run covers, when not all of it: runs covering different parts keep separate records. */
	part?: string
	/** How the runner takes a module's digest; with it a change inside a file reruns only the test files it can reach. */
	digester?: Digester | undefined
	/** Whether a changed file (repository-relative) runs everything by the runner's own configuration. */
	triggers?(file: string): boolean
	log(message: string): void
	warn?(message: string): void
}

/** What `plan` decided, kept for the `commit` that follows the run; plain data, for a runner whose run is another process. */
export interface Pending {
	shard: Shard | null
	/** The test files (keys of the record) the run decides for: those of its shard. */
	owned: string[]
	changed: string[]
	selection: Record<string, Decision>
	/** The changed file that runs everything, when one does: no record outlives it. */
	trigger?: string
	/** The stored record already lost what `changed` invalidates: it came from cache entries, each compared with its own anchor. */
	settled?: boolean
}

export interface PlanOptions {
	shard?: Shard | null
	/** Why every test file runs whatever the record says (`coverage`: of a part of the test files it would fail or pass thresholds for the wrong reason). The record is still read, for the run to add to. */
	all?: string | undefined
}

export interface CommitOptions {
	/** What each test file of the run entered, for narrowing. */
	entered?: ReadonlyMap<string, Entered>
	/** Whether a record's test file is still one the runner has; the file existing is checked either way. */
	keep?(spec: string): boolean
}

export interface Committed {
	records: Records
	/** Test files nothing in the record says to run again. */
	vouched: number
	anchored: number
}

export class Session {
	readonly runner: Runner
	readonly store: Store
	readonly rules: Rules
	readonly #scope: Scope

	constructor(runner: Runner) {
		this.runner = runner
		const base = runner.rulesBase ? toRelative(runner.repo, runner.rulesBase) : ''
		this.rules = compileRules(runner.options, base, runner.repo)
		this.#scope = {
			repo: runner.repo,
			cwd: runner.cwd,
			always: runner.always,
			rules: this.rules,
			rulesBase: base,
			warn: runner.warn ?? runner.log,
		}
		this.store = new Store({
			runner: runner.name,
			dir: runner.dir,
			repo: runner.repo,
			cwd: runner.cwd,
			...(runner.part === undefined ? {} : { part: runner.part }),
			...(runner.options.maxShards === undefined
				? {}
				: { maxShards: runner.options.maxShards }),
			log: runner.log,
		})
	}

	/** Fails for a run split into more shards than `maxShards`: its record would not be found by the others. */
	checkShard(shard: Shard, flag: string, raise: string): void {
		if (shard.count > this.store.maxShards) {
			throw new Error(
				`${flag} splits the run into more than maxShards (${this.store.maxShards}) shards; ${raise} to at least ${shard.count}`,
			)
		}
	}

	#tree(records: Records, anchor?: Anchor): ReturnType<typeof currentTree> {
		return currentTree(
			this.#scope,
			// The anchor's own paths too: one that is gone is a change, and a
			// recorded one that did not exist appears in the diff once it does.
			[...Object.keys(anchor?.tree ?? {}), ...recordedPaths(records)],
			readManifests(records),
		)
	}

	/** The first changed file that runs everything: a config file of the runner, the workflow, or one the runner itself names. */
	#trigger(changed: readonly string[]): string | undefined {
		const always = new Set(alwaysPaths(this.#scope))
		return changed.find((file) => always.has(file) || this.runner.triggers?.(file))
	}

	#affects(records: Records, changed: readonly string[], units: string): Affects | undefined {
		const { digester, repo } = this.runner
		return digester ? affecting(repo, units, digester, records, changed) : undefined
	}

	/** Which of the test files `owned` have to run, and why. Never throws for a record it cannot use: those test files run. */
	async plan(owned: readonly string[], options: PlanOptions = {}): Promise<Pending> {
		const shard = options.shard ?? null
		const all = options.all
		const entries = await this.store.restore(shard)
		if (entries.length > 0) {
			try {
				return await this.#fromEntries(entries, owned, shard, all)
			} finally {
				for (const entry of entries) rmSync(entry.dir, { recursive: true, force: true })
			}
		}
		const records = this.store.readRecords(shard)
		const anchor = this.store.readAnchor(shard)
		const everything = (reason: string): Record<string, Decision> =>
			Object.fromEntries(owned.map((spec) => [spec, { run: true, reason }]))
		if (!records || !anchor) {
			return { shard, owned: [...owned], changed: [], selection: everything('no record') }
		}
		const changed = await changedSince(
			this.runner.repo,
			anchor,
			await this.#tree(records, anchor),
		)
		const pending: Pending = { shard, owned: [...owned], changed, selection: {} }
		const trigger = this.#trigger(changed)
		if (trigger !== undefined) {
			pending.trigger = trigger
			pending.selection = everything(`changed: ${trigger}`)
		} else if (all !== undefined) {
			pending.selection = everything(all)
		} else {
			pending.selection = select(records, owned, changed, {
				rules: this.rules,
				affects: this.#affects(records, changed, this.store.unitsFile(shard)),
			})
		}
		return pending
	}

	/**
	 * The decision when the records come from cache entries. Each test file
	 * is taken from the entry that ran it last, and that entry decides for it
	 * against its own anchor, as a run restoring it alone would. What is left
	 * of them all becomes the stored record: every test file nothing changed
	 * for, this shard's and the others'.
	 */
	async #fromEntries(
		entries: readonly Entry[],
		owned: readonly string[],
		shard: Shard | null,
		all: string | undefined,
	): Promise<Pending> {
		const from = new Map<string, { time: number; entry: Entry }>()
		for (const entry of entries) {
			for (const [spec, record] of Object.entries(entry.records.files)) {
				const time = record.at ?? 0
				const known = from.get(spec)
				if (known === undefined || time > known.time) from.set(spec, { time, entry })
			}
		}
		const merged = emptyRecords()
		const selection: Record<string, Decision> = Object.fromEntries(
			owned.map((spec) => [spec, { run: true, reason: 'no record' }]),
		)
		const mine = new Set(owned)
		const changed = new Set<string>()
		const sources: Array<{ records: Records; units: string; specs: string[] }> = []
		// Set while every entry so far ran into a file that runs everything.
		let triggered: string | undefined
		let spared = false
		for (const entry of entries) {
			const specs = [...from].filter(([, taken]) => taken.entry === entry).map(([spec]) => spec)
			if (specs.length === 0) continue
			const records: Records = {
				...entry.records,
				files: Object.fromEntries(
					specs.flatMap((spec) => {
						const record = entry.records.files[spec]
						return record ? [[spec, record]] : []
					}),
				),
			}
			// Whatever becomes of its test files: what every test file depends
			// on is loaded once and not again by each run.
			merged.global = [...new Set([...merged.global, ...records.global])].sort()
			for (const [project, files] of Object.entries(records.projects)) {
				merged.projects[project] = [
					...new Set([...(merged.projects[project] ?? []), ...files]),
				].sort()
			}
			const differs = await changedSince(
				this.runner.repo,
				entry.anchor,
				await this.#tree(entry.records, entry.anchor),
			)
			for (const file of differs) changed.add(file)
			const trigger = this.#trigger(differs)
			if (trigger !== undefined) {
				triggered ??= trigger
				for (const spec of specs) {
					if (mine.has(spec)) selection[spec] = { run: true, reason: `changed: ${trigger}` }
				}
				continue
			}
			spared = true
			const policy: Policy = {
				rules: this.rules,
				affects: all === undefined ? this.#affects(records, differs, entry.units) : undefined,
			}
			const verdict = select(records, specs, differs, policy)
			for (const spec of specs) {
				const decision = verdict[spec]
				if (!decision || !mine.has(spec)) continue
				selection[spec] = all === undefined ? decision : { run: true, reason: all }
			}
			// Without what the changes invalidate, as a run on this entry alone would store it.
			const kept = dropStale(records, differs, policy)
			Object.assign(merged.files, kept.files)
			for (const [file, to] of Object.entries(kept.graph)) {
				merged.graph[file] = [...new Set([...(merged.graph[file] ?? []), ...to])].sort()
			}
			if (Object.keys(kept.files).length === 0) continue
			merged.at = Math.max(merged.at, records.at)
			sources.push({ records: entry.records, units: entry.units, specs: Object.keys(kept.files) })
		}
		this.store.writeRecords(shard, merged)
		if (this.runner.digester) mergeUnits(this.store.unitsFile(shard), merged, sources)
		return {
			shard,
			owned: [...owned],
			changed: [...changed],
			selection,
			settled: true,
			...(triggered === undefined || spared ? {} : { trigger: triggered }),
		}
	}

	/**
	 * Merges what the runs recorded into the record, moves the anchor to the
	 * files as they are now and saves both to the Actions cache. `runs` are
	 * the run `pending` was planned for, or the shards of it.
	 */
	async commit(
		pending: Pending,
		runs: readonly RunRecord[],
		options: CommitOptions = {},
	): Promise<Committed> {
		const { repo, cwd, digester } = this.runner
		const { shard } = pending
		// pnpm: a test also depends on the links that led to its packages.
		const links = new PackageLinks(repo)
		const expanded = runs.map((run): RunRecord => {
			const files: RunRecord['files'] = {}
			for (const [spec, entry] of Object.entries(run.files)) {
				const from = [specPath(spec)]
				const tests: typeof entry.tests = {}
				for (const [title, test] of Object.entries(entry.tests)) {
					tests[title] = test.deps ? { ...test, deps: links.expand(test.deps, from) } : test
				}
				const deps = links.expand(entry.deps, from)
				files[spec] = {
					...entry,
					deps,
					tests,
					// A runner that does not say which manifests a test read itself: every one it names.
					manifests:
						entry.manifests ??
						[...deps, ...Object.values(tests).flatMap((test) => test.deps ?? [])].filter(
							(file) => path.posix.basename(file) === 'package.json' && !isPackagePath(file),
						),
				}
			}
			return {
				at: run.at,
				// Run from a workspace, the runner and what it loads are linked there.
				global: links.expand(run.global, [`${toRelative(repo, cwd) || '.'}/.`]),
				...(run.projects ? { projects: run.projects } : {}),
				graph: Object.fromEntries(
					Object.entries(run.graph ?? {}).map(([from, to]) => [from, links.expand(to, [from])]),
				),
				files,
			}
		})
		// A record put together from cache entries has lost what the change staled already.
		const changed = pending.settled ? [] : pending.changed
		const before = this.store.readRecords(shard)
		const policy: Policy = {
			rules: this.rules,
			affects:
				before && changed.length > 0
					? this.#affects(before, changed, this.store.unitsFile(shard))
					: undefined,
		}
		// A changed config is in no test file's dependencies, yet stales every
		// record: a file this run left out keeps none. The packages in
		// `global` outlive it: with a warm transform cache this run did not
		// load the transformer's packages, and a later one would.
		const stored =
			pending.trigger !== undefined && !pending.settled && before
				? {
						...before,
						files: {},
						graph: {},
						projects: {},
						global: before.global.filter(isPackagePath),
					}
				: before
		const merged = mergeRecords(stored, expanded, changed, policy)
		for (const spec of Object.keys(merged.files)) {
			// Deleted since, or no longer a test file the runner has under this key.
			if (
				!existsSync(path.join(repo, specPath(spec))) ||
				options.keep?.(spec) === false
			) {
				delete merged.files[spec]
			}
		}
		merged.global = merged.global.filter(
			(file) => !isPackagePath(file) || existsSync(path.join(repo, file)),
		)
		if (digester && options.entered) {
			updateUnits(repo, this.store.unitsFile(shard), digester, before, merged, options.entered)
		} else dropUnits(this.store.unitsFile(shard))
		const tree = await currentTree(this.#scope, recordedPaths(merged), readManifests(merged))
		this.store.writeRecords(shard, merged)
		this.store.writeAnchor(shard, {
			tree,
			head: await headSha(repo).catch(() => ''),
			runtime: runtimeId(),
			job: jobId(),
		})
		const committed: Committed = {
			records: merged,
			vouched: Object.values(merged.files).filter(vouched).length,
			anchored: Object.keys(tree).length,
		}
		await this.store.save(shard)
		return committed
	}
}

/** What a selection decided: a line that sums it up, then one per test file that runs. */
export function describeSelection(pending: Pending, noun: string): string[] {
	const entries = Object.entries(pending.selection)
	const run = entries.filter(([, decision]) => decision.run)
	const shard = pending.shard ? ` in shard ${pending.shard.index}/${pending.shard.count}` : ''
	const changed =
		pending.changed.length > 0
			? `; changed: ${pending.changed.slice(0, 10).join(', ')}${pending.changed.length > 10 ? `, and ${pending.changed.length - 10} more` : ''}`
			: ''
	const lines = [`${run.length} of ${entries.length} ${noun}(s) affected${shard}${changed}`]
	for (const [spec, decision] of run) {
		if (!decision.run) continue
		const named = specProject(spec)
		const project = named ? `in ${named}, ` : ''
		const tests = decision.tests ? `${decision.tests.length} of its tests: ` : ''
		lines.push(`  run  ${specPath(spec)}  (${project}${tests}${decision.reason})`)
	}
	return lines
}
