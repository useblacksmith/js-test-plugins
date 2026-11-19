import { AsyncLocalStorage } from 'node:async_hooks'
import {
	isPackagePath,
	packageDir,
	packageOf,
	repositoryPackage,
} from '../../shared/src/packages.ts'
import Module, { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
	BRAND,
	CHILD_RECORD_ENV,
	ENV_RECORD_ROOT,
	ENV_REPO,
	Outputs,
	WRITE_PREFIX,
	copyProperties,
	isIgnored,
	wrapFs,
} from '../../shared/src/fs-recorder.ts'
import type { SpecRecord } from './core.ts'
import { ENV_COMMIT, ENV_RUN, dataDir } from './paths.ts'
import { unionPieces, type Piece } from './pieces.ts'

/**
 * Mocha's preload (`mocha --require @useblacksmith/mocha/register`), loaded
 * by the main process and, with `--parallel`, by every worker process.
 *
 * Mocha loads all spec files of a process into one module cache, so what a
 * spec depends on cannot be read off a per-file module graph. This records:
 *
 * - importer → imported edges, from `Module._load` (every `require()`, cached
 *   or not) and a `module.registerHooks` resolve hook (every ESM import);
 *   neither sees all of them alone.
 * - files read through `node:fs`, the node processes and worker threads
 *   started (via `record-child`) and the sockets written to, charged to the
 *   module being loaded or to the test or hook that is running.
 * - per spec file, every test title and the state of each test that ran.
 */
const require = createRequire(import.meta.url)
const STATE = Symbol.for('blacksmith.mocha.recorder')

type Target =
	| { type: 'module'; file: string }
	| { type: 'test'; file: string; title: string }
	| { type: 'hook'; file: string }
	/** A root-level hook of no file. */
	| { type: 'global' }
	/** A package on the stack and no repository module. */
	| { type: 'none' }
	/** Only Node itself on the stack: its loaders reading a module's source. */
	| { type: 'internal' }

interface TestEntry {
	state: 'passed' | 'failed' | 'pending' | undefined
	deps: Set<string>
	endpoints: Set<string>
}

interface FileEntry {
	tests: Map<string, TestEntry>
	hooks: Set<string>
	hookEndpoints: Set<string>
	all: string[]
	hookFailed: boolean
}

interface Child {
	dir: string | null
	cwd: string
	to: Target
}

/** The parts of Mocha's `Runnable`, `Suite` and `Runner` the recorder reads. */
interface Runnable {
	type?: string
	title: string
	file?: string
	parent?: { file?: string }
	ctx?: { currentTest?: Runnable }
	fullTitle(): string
}
interface Suite {
	tests: Runnable[]
	suites: Suite[]
}
interface Runner {
	suite: Suite
	on(event: string, listener: (runnable: Runnable) => void): void
}
type Method = (this: unknown, ...args: never[]) => unknown
interface MochaExports {
	Runner?: { prototype: { run: Method } }
	Runnable?: { prototype: { run: Method } }
	[STATE]?: boolean
}

type Env = Record<string, string | undefined>
type Wrappable = Record<string, unknown>

// Preloaded through NODE_OPTIONS, this file also reaches the processes and
// worker threads a test starts: those report through `record-child` instead.
const workerThreads =
	require('node:worker_threads') as typeof import('node:worker_threads')
const shared = globalThis as { [STATE]?: boolean }
if (
	!shared[STATE] &&
	process.env[CHILD_RECORD_ENV] === undefined &&
	workerThreads.isMainThread
) {
	shared[STATE] = true
	install()
}

function install(): void {
	const fs = require('node:fs') as typeof import('node:fs')
	const childProcess =
		require('node:child_process') as typeof import('node:child_process')
	const net = require('node:net') as typeof import('node:net')
	// Unwrapped, so the recorder's own file handling records nothing.
	const raw = {
		existsSync: fs.existsSync,
		mkdirSync: fs.mkdirSync,
		mkdtempSync: fs.mkdtempSync,
		readdirSync: fs.readdirSync,
		readFileSync: fs.readFileSync,
		rmSync: fs.rmSync,
		statSync: fs.statSync,
		writeFileSync: fs.writeFileSync,
		spawnSync: childProcess.spawnSync,
	}
	const here = path.dirname(fileURLToPath(import.meta.url))
	const source = import.meta.url.endsWith('.ts')
	const recordChild = path.resolve(
		here,
		source
			? '../../shared/src/record-child.ts'
			: '../../shared/src/record-child.js',
	)
	/** The plugin's own modules, which are no test's dependency. */
	const ownDirs = [here + path.sep, path.dirname(recordChild) + path.sep]
	const own = (file: string) => ownDirs.some((dir) => file.startsWith(dir))

	const isMain = process.env[ENV_RECORD_ROOT] === undefined
	if (process.env[ENV_REPO] === undefined) {
		const top = raw.spawnSync('git', ['rev-parse', '--show-toplevel'], {
			encoding: 'utf8',
		})
		process.env[ENV_REPO] =
			top.status === 0 ? top.stdout.trim() : process.cwd()
	}
	const repo = process.env[ENV_REPO] ?? process.cwd()
	const recordRoot = (process.env[ENV_RECORD_ROOT] ??= raw.mkdtempSync(
		path.join(os.tmpdir(), 'blacksmith-mocha-'),
	))
	const runFile =
		process.env[ENV_RUN] ?? path.join(dataDir(process.cwd()), 'run.json')

	const rel = (file: string) =>
		path.relative(repo, file).split(path.sep).join('/')
	const ignored = (file: string) =>
		file === repo || isIgnored(file) || own(file)

	const graph = new Map<string, Set<string>>()
	const entries = new Set<string>()
	const unattributed = new Set<string>()
	// What loaded before the recorder: Mocha, and what its config required.
	for (const file of Object.keys(require.cache)) {
		const dir = repositoryPackage(repo, file)
		if (dir !== null) unattributed.add(rel(dir))
	}
	/** Every repository file loaded as a module; Node's loaders read their source through the wrapped fs. */
	const modules = new Set<string>()
	const files = new Map<string, FileEntry>()
	const outputs = new Outputs()
	const loadStack: string[] = []
	const running = new AsyncLocalStorage<Target>()

	function addEdge(from: string, to: string): void {
		const a = rel(from)
		const b = rel(to)
		if (a === b) return
		let set = graph.get(a)
		if (!set) graph.set(a, (set = new Set()))
		set.add(b)
	}

	function fileEntry(spec: string): FileEntry {
		let entry = files.get(spec)
		if (!entry) {
			entry = {
				tests: new Map(),
				hooks: new Set(),
				hookEndpoints: new Set(),
				all: [],
				hookFailed: false,
			}
			files.set(spec, entry)
		}
		return entry
	}

	function testEntry(spec: string, title: string): TestEntry {
		const entry = fileEntry(spec)
		let test = entry.tests.get(title)
		if (!test) {
			test = { state: undefined, deps: new Set(), endpoints: new Set() }
			entry.tests.set(title, test)
		}
		return test
	}

	/** The nearest repository module on the stack; `external` when a package was on it and no repository module. */
	function callerModule(): { file?: string; external: boolean } {
		const prepare = Error.prepareStackTrace
		const limit = Error.stackTraceLimit
		Error.stackTraceLimit = 64
		Error.prepareStackTrace = (_, sites) => sites
		let sites: unknown
		try {
			sites = new Error().stack
		} finally {
			Error.prepareStackTrace = prepare
			Error.stackTraceLimit = limit
		}
		let external = false
		if (!Array.isArray(sites)) return { external }
		for (const site of sites as NodeJS.CallSite[]) {
			let name = site.getFileName()
			if (!name) continue
			if (name.startsWith('file:')) name = fileURLToPath(name)
			if (!path.isAbsolute(name) || own(name)) continue
			if (ignored(name)) {
				external = true
				continue
			}
			return { file: name, external }
		}
		return { external }
	}

	/** Who something observed right now is charged to. */
	function target(): Target {
		const loading = loadStack.at(-1)
		if (loading !== undefined) return { type: 'module', file: loading }
		const store = running.getStore()
		if (store) return store
		const caller = callerModule()
		if (caller.file !== undefined) return { type: 'module', file: caller.file }
		return { type: caller.external ? 'none' : 'internal' }
	}

	function charge(to: Target, absolute: string, content = true): void {
		if (to.type === 'module') addEdge(to.file, absolute)
		else if (to.type === 'test') {
			testEntry(rel(to.file), to.title).deps.add(rel(absolute))
		} else if (to.type === 'hook') fileEntry(rel(to.file)).hooks.add(rel(absolute))
		else if (to.type === 'global') unattributed.add(rel(absolute))
		else if (to.type === 'none' && content && !modules.has(rel(absolute))) {
			// A package reading a repository file on nobody's behalf (dotenv
			// preloaded with --require, Mocha reading its config): an input of
			// every test. Mocha's spec lookup only probes and lists directories.
			try {
				if (raw.statSync(absolute).isDirectory()) return
			} catch {
				return
			}
			unattributed.add(rel(absolute))
		}
	}

	/** The package.json files the command compares whatever the record says: the repository's and the working directory's. */
	const ALWAYS_MANIFESTS = new Set([
		path.join(repo, 'package.json'),
		path.join(process.cwd(), 'package.json'),
	])

	/** Whether the read under way was made by an installed package: the frame nearest to the call decides. */
	function readByPackage(): boolean {
		const frame = (new Error().stack ?? '')
			.split('\n')
			.slice(1)
			.find(
				(line) =>
					!line.includes('node:') &&
					!line.includes(
						`${path.sep}shared${path.sep}src${path.sep}fs-recorder.`,
					) &&
					!line.includes(here),
			)
		return frame !== undefined && isPackagePath(frame)
	}

	function read(file: string, content: boolean): void {
		let absolute = path.resolve(file)
		// A file of an installed package read as data: the package.
		const installed = content ? packageOf(repo, absolute) : null
		if (installed !== null) absolute = installed
		else if (ignored(absolute) || !outputs.reads(absolute, content)) return
		// A package.json every change of which is looked at anyway, read by a tool (Babel, browserslist) for a field
		// of its own: its fields outside the dependencies rerun everything as it is.
		if (ALWAYS_MANIFESTS.has(absolute) && readByPackage()) return
		const to = target()
		charge(to, absolute, content)
		// A value read once and kept (a config loaded on first use) is never
		// read again by the spec files that run later in this process: the
		// module that did the read is charged too, so every spec importing it
		// depends on the file.
		if (to.type === 'test' || to.type === 'hook') {
			const caller = callerModule().file
			if (caller !== undefined && caller !== to.file) addEdge(caller, absolute)
		}
	}

	function wrote(file: string): void {
		const absolute = path.resolve(file)
		if (!ignored(absolute)) outputs.writes(absolute)
	}

	// ---- imports ----------------------------------------------------------
	function noteLoad(from: string | undefined, to: string): void {
		// An installed package stands for its files: whoever loads one of them
		// depends on the package, and the package on the packages it loads.
		if (isPackagePath(to)) {
			const dir = repositoryPackage(repo, to)
			const parent =
				from === undefined
					? loadStack.at(-1)
					: isPackagePath(from)
						? repositoryPackage(repo, from)
						: from
			if (dir !== null && parent && parent !== dir) addEdge(parent, dir)
			return
		}
		if (ignored(to)) return
		// A CommonJS module imported from ESM reaches `Module._load` with no
		// parent; the resolve hook already saw its importer.
		const known = from === undefined && modules.has(rel(to))
		modules.add(rel(to))
		const store = running.getStore()
		const loading = loadStack.at(-1)
		if (from !== undefined && !ignored(from)) addEdge(from, to)
		else if (loading !== undefined) addEdge(loading, to)
		else if (!store && !known) entries.add(rel(to))
		// A `require()` inside a test: a dependency of that test as well.
		if (store) charge(store, to)
	}

	const cjs = Module as unknown as {
		_load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown
		_resolveFilename(request: string, parent: unknown, isMain: boolean): string
	}
	const load = cjs._load
	const mochaEntry = `${path.sep}mocha${path.sep}lib${path.sep}mocha.js`
	cjs._load = function (request, parent, isMainModule) {
		let filename: string | undefined
		if (!Module.isBuiltin(request)) {
			try {
				filename = cjs._resolveFilename(request, parent, isMainModule)
			} catch {}
		}
		if (filename === undefined || !path.isAbsolute(filename)) {
			return load.call(this, request, parent, isMainModule)
		}
		noteLoad(parent?.filename, filename)
		const push = !ignored(filename)
		if (push) loadStack.push(filename)
		try {
			return load.call(this, request, parent, isMainModule)
		} finally {
			if (push) loadStack.pop()
			if (filename.endsWith(mochaEntry)) {
				patchMocha(require.cache[filename]?.exports as MochaExports)
			}
		}
	}
	// Node 22.15+. Called once per importer and specifier, so a module already
	// in the module map still yields the edge from each new importer.
	if (typeof Module.registerHooks === 'function') {
		Module.registerHooks({
			resolve(specifier, context, next) {
				const result = next(specifier, context)
				try {
					if (result.url.startsWith('file:')) {
						noteLoad(
							context.parentURL?.startsWith('file:')
								? fileURLToPath(context.parentURL)
								: undefined,
							fileURLToPath(result.url),
						)
					}
				} catch {}
				return result
			},
		})
	}

	// ---- fs ---------------------------------------------------------------
	wrapFs(fs, read, wrote)

	// ---- child processes and worker threads -------------------------------
	const outstanding = new Set<Child>()

	/** `given` with the child recorder preloaded and a directory to report to; `null` when the caller cleared NODE_OPTIONS on purpose. */
	function recordedEnv(given: Env | undefined): { env: Env; dir: string } | null {
		if (
			given !== undefined &&
			Object.prototype.hasOwnProperty.call(given, 'NODE_OPTIONS') &&
			given.NODE_OPTIONS === undefined
		) {
			return null
		}
		const env: Env = { ...(given ?? process.env) }
		const dir = raw.mkdtempSync(path.join(recordRoot, 'c-'))
		env[CHILD_RECORD_ENV] = dir
		env.NODE_OPTIONS = [
			env.NODE_OPTIONS,
			`--import ${pathToFileURL(recordChild).href}`,
		]
			.filter(Boolean)
			.join(' ')
		return { env, dir }
	}

	/** Charges what the child has reported so far to whoever started it. */
	function collect(child: Child, final: boolean): void {
		if (child.dir === null) return
		let names: string[] = []
		try {
			names = raw.readdirSync(child.dir)
		} catch {}
		for (const name of names) {
			let text = ''
			try {
				text = raw.readFileSync(path.join(child.dir, name), 'utf8')
			} catch {}
			for (const line of text.split('\n')) {
				if (line === '') continue
				if (line.startsWith(WRITE_PREFIX)) {
					outputs.writes(
						path.resolve(child.cwd, line.slice(WRITE_PREFIX.length)),
					)
					continue
				}
				const absolute = path.resolve(child.cwd, line)
				// The child reports a package it loaded or read by its directory.
				if (
					packageDir(absolute) === absolute
						? packageOf(repo, absolute) !== null
						: !ignored(absolute) && outputs.reads(absolute, true)
				) {
					charge(child.to, absolute)
				}
			}
		}
		if (final) outstanding.delete(child)
	}

	/** The options object of a `child_process` call, inserted when the call had none. */
	function optionsOf(args: unknown[]): Record<string, unknown> {
		let index = args.findIndex(
			(arg, i) =>
				i > 0 && typeof arg === 'object' && arg !== null && !Array.isArray(arg),
		)
		if (index === -1) {
			index = Array.isArray(args[1]) ? 2 : 1
			args.splice(index, 0, {})
		}
		const options = { ...(args[index] as Record<string, unknown>) }
		args[index] = options
		return options
	}

	function instrument(args: unknown[]): Child {
		const to = target()
		// Mocha's own worker pool forks with nothing of the repository on the stack.
		if (to.type === 'none' || to.type === 'internal') {
			return { dir: null, cwd: process.cwd(), to }
		}
		const options = optionsOf(args)
		const cwd =
			typeof options.cwd === 'string'
				? path.resolve(options.cwd)
				: options.cwd instanceof URL
					? fileURLToPath(options.cwd)
					: process.cwd()
		const recorded = recordedEnv(options.env as Env | undefined)
		if (recorded) options.env = recorded.env
		// The command and every argument naming a file: all a child that is
		// not node (a shell script, a binary) can contribute.
		const words = [
			...(typeof args[0] === 'string' ? args[0].split(/\s+/) : []),
			...(Array.isArray(args[1]) ? (args[1] as unknown[]) : []),
		]
		for (const word of words) {
			if (typeof word !== 'string' || word === '') continue
			const candidate = path.resolve(cwd, word)
			try {
				if (
					!ignored(candidate) &&
					raw.existsSync(candidate) &&
					raw.statSync(candidate).isFile()
				) {
					charge(to, candidate)
				}
			} catch {}
		}
		const child: Child = { dir: recorded?.dir ?? null, cwd, to }
		if (child.dir !== null) outstanding.add(child)
		return child
	}

	function wrapChildProcess(name: string, sync: boolean): void {
		const object = childProcess as unknown as Wrappable
		const original = object[name]
		if (typeof original !== 'function' || BRAND in original) return
		const call = original as (...args: unknown[]) => unknown
		const wrapped = sync
			? function (this: unknown, ...args: unknown[]) {
					const child = instrument(args)
					try {
						return call.apply(this, args)
					} finally {
						collect(child, true)
					}
				}
			: function (this: unknown, ...args: unknown[]) {
					const child = instrument(args)
					const started = call.apply(this, args) as
						| { once?: (event: string, listener: () => void) => unknown }
						| undefined
					// Only `exit`: an `error` listener would keep a spawn failure
					// from surfacing as the uncaught error it is.
					if (typeof started?.once === 'function') {
						started.once('exit', () => collect(child, true))
					}
					return started
				}
		copyProperties(wrapped, original)
		Object.defineProperty(wrapped, BRAND, { value: true })
		object[name] = wrapped
	}
	for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
		wrapChildProcess(name, false)
	}
	for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
		wrapChildProcess(name, true)
	}

	type WorkerOptions = import('node:worker_threads').WorkerOptions
	type Worker = import('node:worker_threads').Worker
	const OriginalWorker = workerThreads.Worker
	function RecordedWorker(
		this: unknown,
		filename: string | URL,
		options?: WorkerOptions,
	): Worker {
		const construct = (given: WorkerOptions | undefined) =>
			Reflect.construct(
				OriginalWorker,
				[filename, given],
				new.target ?? RecordedWorker,
			) as Worker
		const to = target()
		if (to.type === 'none' || to.type === 'internal') return construct(options)
		const script =
			options?.eval === true
				? null
				: filename instanceof URL
					? filename.protocol === 'file:'
						? fileURLToPath(filename)
						: null
					: filename
		if (script !== null && !ignored(path.resolve(script))) {
			charge(to, path.resolve(script))
		}
		// A worker sharing the parent's environment contributes only its script.
		const recorded =
			options?.env === workerThreads.SHARE_ENV
				? null
				: recordedEnv(options?.env as Env | undefined)
		if (!recorded) return construct(options)
		const child: Child = { dir: recorded.dir, cwd: process.cwd(), to }
		outstanding.add(child)
		let worker: Worker
		try {
			worker = construct({ ...options, env: recorded.env })
		} catch (error) {
			outstanding.delete(child)
			// The parent's NODE_OPTIONS holds an option a worker may not carry.
			if (
				(error as { code?: unknown }).code !== 'ERR_WORKER_INVALID_EXEC_ARGV'
			) {
				throw error
			}
			return construct(options)
		}
		worker.once('exit', () => collect(child, true))
		return worker
	}
	RecordedWorker.prototype = OriginalWorker.prototype
	Object.setPrototypeOf(RecordedWorker, OriginalWorker)
	copyProperties(RecordedWorker, OriginalWorker)
	;(workerThreads as unknown as Wrappable).Worker = RecordedWorker

	// ---- sockets: which services a test talks to --------------------------
	const ENDPOINT = Symbol('blacksmith.mocha.endpoint')
	type Socket = import('node:net').Socket & { [ENDPOINT]?: string }

	function noteEndpoint(endpoint: string): void {
		const store = running.getStore()
		if (store?.type === 'test') {
			testEntry(rel(store.file), store.title).endpoints.add(endpoint)
		} else if (store?.type === 'hook') {
			fileEntry(rel(store.file)).hookEndpoints.add(endpoint)
		}
	}

	/** `host:port` or `unix:<path>` of a `connect()` call's arguments, loopback addresses as `localhost`. */
	function endpointOf(args: unknown[]): string | undefined {
		const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0]
		const second: unknown = Array.isArray(args[0]) ? args[0][1] : args[1]
		let endpoint: string | undefined
		if (typeof first === 'object' && first !== null) {
			const options = first as {
				path?: string | null
				host?: string | null
				port?: unknown
			}
			endpoint =
				typeof options.path === 'string'
					? `unix:${options.path}`
					: `${options.host ?? 'localhost'}:${String(options.port)}`
		} else if (typeof first === 'number' || /^\d+$/.test(String(first))) {
			endpoint = `${typeof second === 'string' ? second : 'localhost'}:${String(first)}`
		} else if (typeof first === 'string') endpoint = `unix:${first}`
		return endpoint?.replace(/^(127\.0\.0\.1|::1|\[::1\]):/, 'localhost:')
	}

	const socket = net.Socket.prototype as unknown as Record<
		'connect' | 'write',
		(this: Socket, ...args: unknown[]) => unknown
	>
	const connect = socket.connect
	socket.connect = function (...args) {
		try {
			const endpoint = endpointOf(args)
			if (endpoint !== undefined) {
				this[ENDPOINT] = endpoint
				noteEndpoint(endpoint)
			}
		} catch {}
		return connect.apply(this, args)
	}
	// A pooled connection an earlier spec file opened is only ever written to.
	const write = socket.write
	socket.write = function (...args) {
		const endpoint = this[ENDPOINT]
		if (endpoint !== undefined) noteEndpoint(endpoint)
		return write.apply(this, args)
	}

	// `import { readFileSync } from 'node:fs'` binds the builtin's ESM
	// namespace, which only sees the wrappers once it is resynced.
	syncBuiltinESMExports()

	// ---- Mocha: which test or hook is running ------------------------------
	function patchMocha(mocha: MochaExports | undefined): void {
		if (!mocha?.Runner || !mocha.Runnable || mocha[STATE]) return
		mocha[STATE] = true
		const runRunnable = mocha.Runnable.prototype.run as (
			this: Runnable,
			fn: unknown,
		) => unknown
		mocha.Runnable.prototype.run = function (this: Runnable, fn: unknown) {
			const test = this.type === 'test' ? this : this.ctx?.currentTest
			const each =
				this.type === 'hook' && /^"(before|after) each" hook/.test(this.title)
			const file =
				this.type === 'test'
					? this.file
					: each
						? test?.file
						: (this.file ?? this.parent?.file)
			let store: Target
			if (file === undefined) store = { type: 'global' }
			else if (test && (this.type === 'test' || each)) {
				store = { type: 'test', file, title: test.fullTitle() }
			} else store = { type: 'hook', file }
			return running.run(store, () => runRunnable.call(this, fn))
		} as Method
		const runRunner = mocha.Runner.prototype.run as (
			this: Runner,
			...args: unknown[]
		) => unknown
		mocha.Runner.prototype.run = function (this: Runner, ...args: unknown[]) {
			const specs = new Set<string>()
			const walk = (suite: Suite) => {
				for (const test of suite.tests) {
					if (test.file === undefined) continue
					const spec = rel(test.file)
					specs.add(spec)
					fileEntry(spec).all.push(test.fullTitle())
				}
				for (const child of suite.suites) walk(child)
			}
			walk(this.suite)
			const state =
				(value: 'passed' | 'failed' | 'pending') => (runnable: Runnable) => {
					if (runnable.type === 'hook') {
						const file =
							runnable.file ??
							runnable.ctx?.currentTest?.file ??
							runnable.parent?.file
						if (file !== undefined) fileEntry(rel(file)).hookFailed = true
					} else if (runnable.file !== undefined) {
						testEntry(rel(runnable.file), runnable.fullTitle()).state = value
					}
				}
			this.on('pass', state('passed'))
			this.on('fail', state('failed'))
			this.on('pending', state('pending'))
			this.on('end', () => flush(specs))
			return runRunner.apply(this, args)
		} as Method
	}
	for (const [id, module] of Object.entries(require.cache)) {
		if (id.endsWith(mochaEntry)) patchMocha(module?.exports as MochaExports)
	}

	// ---- the run's record ---------------------------------------------------
	let sequence = 0
	/** Writes one piece per `Runner`: a `--parallel` worker makes a `Runner` per spec file. */
	function flush(specs: Set<string>): void {
		for (const child of outstanding) collect(child, false)
		const piece: Piece = {
			at: Date.now(),
			graph: Object.fromEntries(
				[...graph].map(([from, to]) => [from, [...to].sort()]),
			),
			entries: [...entries],
			unattributed: [...unattributed],
			files: {},
			late: {},
		}
		for (const spec of specs) {
			const entry = files.get(spec)
			if (!entry) continue
			const tests: SpecRecord['tests'] = {}
			for (const [title, test] of entry.tests) {
				if (test.state === undefined) continue
				tests[title] = {
					state: test.state,
					deps: [...test.deps].sort(),
					endpoints: [...test.endpoints].sort(),
				}
			}
			piece.files[spec] = {
				all: [...new Set(entry.all)],
				hookFailed: entry.hookFailed,
				hooks: [...entry.hooks].sort(),
				hookEndpoints: [...entry.hookEndpoints].sort(),
				tests,
			}
			// A worker loads its next spec file into the same process.
			files.delete(spec)
		}
		// What a test of an earlier spec file read after its Runner ended (a timer it never awaited).
		for (const [spec, entry] of files) {
			if (specs.has(spec)) continue
			for (const [title, test] of entry.tests) {
				if (test.state === undefined && test.deps.size > 0) {
					;(piece.late[spec] ??= {})[title] = [...test.deps]
				}
			}
			files.delete(spec)
		}
		raw.writeFileSync(
			path.join(recordRoot, `piece-${process.pid}-${sequence++}.json`),
			JSON.stringify(piece),
		)
	}

	if (!isMain) {
		// A worker's last word: what arrived after its final Runner ended.
		process.on('exit', () => flush(new Set()))
		return
	}
	process.on('exit', () => {
		const pieces = raw
			.readdirSync(recordRoot)
			.filter((name) => name.startsWith('piece-'))
			.map(
				(name) =>
					JSON.parse(
						raw.readFileSync(path.join(recordRoot, name), 'utf8'),
					) as Piece,
			)
		raw.mkdirSync(path.dirname(runFile), { recursive: true })
		raw.writeFileSync(runFile, JSON.stringify(unionPieces(pieces)))
		raw.rmSync(recordRoot, { recursive: true, force: true })
		if (process.env[ENV_COMMIT] === '1') {
			raw.spawnSync(
				process.execPath,
				[path.join(here, source ? 'cli.ts' : 'cli.js'), 'commit'],
				{ stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } },
			)
		}
	})
}
