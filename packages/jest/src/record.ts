import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
	CHILD_RECORD_ENV,
	Outputs,
	isIgnored,
	wrapFs,
} from '../../shared/src/fs-recorder.ts'
import { ENV_RECORD } from './state.ts'

/**
 * Runs in every process and worker thread that runs test files, outside
 * Jest's sandbox. Between `begin` and `end` of a test file it collects:
 *
 * - the files read through `node:fs`, which is the one module a sandboxed
 *   test shares with this process;
 * - the paths node processes the test starts report (`record-child`).
 *
 * The modules the test file loads come from Jest itself, at `end`. A
 * repository file Node's own loader loads (a transformer, an environment,
 * `babel.config.js`) stays loaded for every later test file of the process,
 * so it is reported as a dependency of all of them.
 */
const require = createRequire(import.meta.url)
const fs = require('node:fs') as typeof import('node:fs')
const nodeModule = require('node:module') as typeof import('node:module') & {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown
	_resolveFilename: (request: string, parent: unknown) => string
}
const { threadId } =
	require('node:worker_threads') as typeof import('node:worker_threads')
// Kept from before the wrapping: our own bookkeeping must not count as a read.
const raw = {
	appendFileSync: fs.appendFileSync,
	mkdirSync: fs.mkdirSync,
	readFileSync: fs.readFileSync,
	readdirSync: fs.readdirSync,
	writeFileSync: fs.writeFileSync,
}

/** What one test file loaded, as the process that ran it wrote it. Paths are absolute. */
export interface Piece {
	test: string
	/** Modules loaded and files whose content was read. */
	deps: string[]
	/** Paths only asked about (`stat`, `exists`): a dependency unless it is a directory. */
	probes: string[]
}

interface Current {
	test: string
	deps: Set<string>
	probes: Set<string>
	outputs: Outputs
	childDir: string
}

let current: Current | null = null
let installed = false
/** Open in the main process from the selection to the first test file: what is read then is read for every test file. */
let globalWindow = false
const globals = new Set<string>()

const root = (): string | undefined => process.env[ENV_RECORD]

function reportGlobal(file: string): void {
	const dir = root()
	if (!dir || isIgnored(file) || globals.has(file)) return
	globals.add(file)
	try {
		raw.appendFileSync(
			path.join(dir, `global-${process.pid}-${threadId}.txt`),
			`${file}\n`,
		)
	} catch {}
}

function install(): void {
	if (installed) return
	installed = true
	wrapFs(
		fs,
		(file, content) => {
			if (!current) {
				if (globalWindow && content) reportGlobal(path.resolve(file))
				return
			}
			const absolute = path.resolve(file)
			if (isIgnored(absolute) || !current.outputs.reads(absolute, content))
				return
			;(content ? current.deps : current.probes).add(absolute)
		},
		(file) => {
			if (!current) return
			const absolute = path.resolve(file)
			if (!isIgnored(absolute)) current.outputs.writes(absolute)
		},
	)
	const load = nodeModule._load
	nodeModule._load = function (request, parent, isMain) {
		try {
			const file = nodeModule._resolveFilename(request, parent)
			if (path.isAbsolute(file)) reportGlobal(file)
		} catch {}
		return load.call(this, request, parent, isMain)
	}
}

/** Starts recording in the main process, where `globalSetup` and the config's own modules load. */
export function recordGlobals(): void {
	install()
	globalWindow = true
	// The config file and what it imported are loaded already.
	for (const file of Object.keys(require.cache)) reportGlobal(file)
}

/** Ends what `recordGlobals` started: the test files come next. */
export function endGlobals(): void {
	globalWindow = false
}

const here = path.dirname(fileURLToPath(import.meta.url))
const childRecorder = path.join(
	here,
	import.meta.url.endsWith('.ts')
		? '../../shared/src/record-child.ts'
		: '../../shared/src/record-child.js',
)

/** `env` with the child recorder preloaded and `dir` to report to. */
function childEnvironment(env: NodeJS.ProcessEnv, dir: string): void {
	const preload = `--import=${JSON.stringify(childRecorder)}`
	if (!env.NODE_OPTIONS?.includes(preload)) {
		env.NODE_OPTIONS = [env.NODE_OPTIONS, preload].filter(Boolean).join(' ')
	}
	env[CHILD_RECORD_ENV] = dir
}

/**
 * Starts the record of the test file `test`. `sandboxEnv` is the copy of the
 * environment Jest gave the test, which a test passing `env` to a child reads.
 */
export function begin(
	test: string,
	sandboxEnv: NodeJS.ProcessEnv | undefined,
): void {
	const dir = root()
	if (!dir) return
	install()
	const name = createHash('sha1').update(test).digest('hex')
	const childDir = path.join(
		dir,
		'children',
		`${name}-${process.pid}-${threadId}`,
	)
	try {
		raw.mkdirSync(childDir, { recursive: true })
	} catch {}
	childEnvironment(process.env, childDir)
	if (sandboxEnv) childEnvironment(sandboxEnv, childDir)
	current = {
		test,
		deps: new Set(),
		probes: new Set(),
		outputs: new Outputs(),
		childDir,
	}
}

/** Ends the record of the running test file and writes it; `modules` are the files Jest read as its modules. */
export function end(modules: Iterable<string>): void {
	const dir = root()
	const done = current
	current = null
	if (!dir || !done) return
	for (const file of modules) {
		if (!isIgnored(file)) done.deps.add(file)
	}
	try {
		for (const name of raw.readdirSync(done.childDir)) {
			const text = raw.readFileSync(path.join(done.childDir, name), 'utf8')
			for (const line of text.split('\n')) {
				if (line !== '' && path.isAbsolute(line)) done.deps.add(line)
			}
		}
	} catch {}
	const piece: Piece = {
		test: done.test,
		deps: [...done.deps],
		probes: [...done.probes].filter((file) => !done.deps.has(file)),
	}
	try {
		raw.mkdirSync(path.join(dir, 'tests'), { recursive: true })
		raw.writeFileSync(
			path.join(dir, 'tests', `${path.basename(done.childDir)}.json`),
			JSON.stringify(piece),
		)
	} catch {}
}
