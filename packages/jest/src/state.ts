import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

import { analyze } from '../../core/src/units.ts'
import { Session, type Pending } from '../../core/src/engine.ts'
import { resolveDigest } from '../../core/src/narrow.ts'
import type { Options as CoreOptions } from '../../core/src/select.ts'
import type { Shard } from '../../core/src/store.ts'
import { sourceFile } from './mark.ts'

/** What the plugin takes. */
export type Options = Omit<CoreOptions, 'services'>

/** Overrides where the record and anchor are kept. */
export const ENV_DIR = 'BLACKSMITH_JEST_DIR'
/** The directory the processes running tests write what each test file loaded to; made by the config helper. */
export const ENV_RECORD = 'BLACKSMITH_JEST_RECORD'
/** The process that made the directory of `ENV_RECORD`, which a Jest that a test starts inherits and must leave alone. */
export const ENV_RECORD_OWNER = 'BLACKSMITH_JEST_RECORD_OWNER'
/** The `jest-runtime` the project's Jest runs tests with, which the recording runtime extends. */
export const ENV_RUNTIME = 'BLACKSMITH_JEST_RUNTIME'

/** Set when the modules of the repository are to report the functions a test file enters. */
export const ENV_NARROW = 'BLACKSMITH_JEST_NARROW'

/** Under `node_modules`, like other tools' caches: git ignores it and the recorder never records it. */
export function dataDir(cwd: string): string {
	return (
		process.env[ENV_DIR] ??
		path.join(cwd, 'node_modules', '.cache', 'blacksmith-jest')
	)
}

/** Shared by the config helper, the sequencer and the reporter, which Jest loads into its main process one by one. */
export interface State {
	cwd: string
	repo: string
	options: Options
	/** Whether the project's own config lets a run without test files pass. */
	passWithNoTests: boolean
	coverage: boolean
	shard: Shard | null
	/** What the sequencer decided, kept for the reporter that follows the run. */
	pending: Pending | null
	/** The selection the run goes through, made once the sequencer knows the run's projects. */
	session: Session | null
	/** Whether the run looks into changed files. */
	narrow: boolean
	/** Resolves a specifier from a file the way one of the run's projects does. */
	resolve: Resolve
	/** Whether every project resolves modules the same way: `resolve` answers for one of them. */
	oneResolver: boolean
	/** Test files (absolute) several projects of the run have: the record keeps one of each per project. */
	shared: Set<string>
}

/**
 * A project's name in the record: its `displayName`, or the id Jest gives it.
 * Projects without a name often share a `rootDir`; the id is one per project,
 * made from the `rootDir`, the config's path and the project's position.
 */
export function projectName(
	config:
		| {
				displayName?: string | { name?: string }
				id?: string
				rootDir?: string
		  }
		| undefined,
	repo: string,
): string {
	const named = config?.displayName
	const name = typeof named === 'string' ? named : named?.name
	if (name) return name
	if (config?.id) return config.id
	return path
		.relative(repo, config?.rootDir ?? repo)
		.split(path.sep)
		.join('/')
}

export type Resolve = (from: string, specifier: string) => string | null

const KEY = Symbol.for('blacksmith.jest.state')
const holder = globalThis as { [KEY]?: State }

export function repoOf(cwd: string): string {
	try {
		return execFileSync('git', ['rev-parse', '--show-toplevel'], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim()
	} catch {
		return cwd
	}
}

export function state(): State {
	return (holder[KEY] ??= {
		cwd: process.cwd(),
		repo: repoOf(process.cwd()),
		options: {},
		passWithNoTests: false,
		coverage: false,
		shard: null,
		pending: null,
		session: null,
		narrow: false,
		resolve: () => null,
		oneResolver: true,
		shared: new Set(),
	})
}

/** Files of Jest and its transformers that shape every test without any of them reading it. */
const ALWAYS = [
	'.swcrc',
	'.babelrc',
	'.babelrc.json',
	...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'json'].flatMap((extension) => [
		`jest.config.${extension}`,
		`babel.config.${extension}`,
	]),
]

/** The selection for this run: the shared core, told where Jest runs and how its projects resolve modules. */
export function openSession(ctx: State): Session {
	const { repo } = ctx
	return (ctx.session = new Session({
		name: 'jest',
		repo,
		cwd: ctx.cwd,
		dir: dataDir(ctx.cwd),
		options: ctx.options,
		always: ALWAYS,
		// Projects may map one specifier to different files, and the function record keeps one target.
		digester:
			ctx.narrow && ctx.oneResolver
				? {
						digest(module, code) {
							const absolute = path.join(repo, module)
							// A CommonJS module too: what it loads says which changes can reach a test through it.
							const analysis = analyze(code, absolute, undefined, true)
							if (!analysis) return null
							const specifiers: Record<string, string> = {}
							for (const specifier of new Set(analysis.digest.sources)) {
								const target = ctx.resolve(absolute, specifier)
								const inRepo = target === null ? null : sourceFile(repo, target)
								if (inRepo !== null) specifiers[specifier] = inRepo
							}
							return resolveDigest(analysis.digest, specifiers)
						},
					}
				: undefined,
		log,
	}))
}

export function log(message: string): void {
	process.stderr.write(`[blacksmith] ${message}\n`)
}

/**
 * Where the package `name` of the project's Jest is: Jest's own packages are
 * dependencies of `jest`, not of the project, so strict installs (pnpm) only
 * reach them through it.
 */
export function resolveFromJest(cwd: string, name: string): string {
	const chains = [
		[name],
		['jest', '@jest/core', name],
		['jest', 'jest-cli', '@jest/core', name],
		['jest-cli', '@jest/core', name],
		['@jest/core', name],
	]
	for (const chain of chains) {
		try {
			let from = path.join(cwd, 'package.json')
			for (const step of chain) {
				from = createRequire(from).resolve(step)
			}
			return from
		} catch {}
	}
	throw new Error(
		`@useblacksmith/jest: cannot find ${name} from ${cwd}; is jest installed?`,
	)
}
