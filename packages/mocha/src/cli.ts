#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeSelection, Session, type Pending as Planned } from '../../core/src/engine.ts'
import { ENV_REPO } from '../../core/src/fs-recorder.ts'
import { repoRoot } from '../../core/src/git.ts'
import type { Options } from '../../core/src/select.ts'
import { shardFor } from '../../core/src/shard.ts'
import type { Entered } from '../../core/src/unitstore.ts'
import { readJson, writeJson, type Shard } from '../../core/src/store.ts'
import { digester } from './narrow.ts'
import { ENV_IN_CLI, ENV_RUN, dataDir } from './paths.ts'
import type { MochaRun } from './pieces.ts'

/**
 * blacksmith-mocha affected [--shard i/n] [--json] -- <mocha args>
 *   Prints which spec files, and which of their tests, the change affects.
 * blacksmith-mocha run [--shard i/n] [--no-commit] -- <mocha args>
 *   Runs Mocha on the affected spec files and merges what it recorded.
 * blacksmith-mocha commit [run.json ...]
 *   Merges recorded runs (the shards of one CI run) into the record.
 */
const USAGE = `usage:
  blacksmith-mocha run [--shard <i>/<n>] [--no-commit] -- <mocha arguments>
  blacksmith-mocha affected [--shard <i>/<n>] [--json] -- <mocha arguments>
  blacksmith-mocha commit [<run.json> ...]`

export const CONFIG_FILE = 'blacksmith-mocha.json'
/** Files that shape every test without any of them reading it: a change runs everything. */
const ALWAYS = [
	'.mocharc.cjs',
	'.mocharc.js',
	'.mocharc.yaml',
	'.mocharc.yml',
	'.mocharc.jsonc',
	'.mocharc.json',
	// Its `mocha` field holds options as well; compared without its dependency fields unless a test read it.
	'package.json',
	CONFIG_FILE,
]

/** What `affected` decided, kept for the `commit` that follows the run. */
interface Pending extends Planned {
	/** Every spec file Mocha would load, repository-relative. */
	all: string[]
}

interface Context {
	cwd: string
	repo: string
	dir: string
	session: Session
}

const here = path.dirname(fileURLToPath(import.meta.url))
const source = import.meta.url.endsWith('.ts')

/** With `--json`, stdout carries the JSON alone. */
let logToStderr = false

function log(message: string): void {
	const line = `[blacksmith] ${message}`
	if (logToStderr) console.error(line)
	else console.log(line)
}

async function context(): Promise<Context> {
	const cwd = process.cwd()
	const repo = await repoRoot(cwd)
	process.env[ENV_REPO] = repo
	const file = path.join(cwd, CONFIG_FILE)
	let options: Options = {}
	if (existsSync(file)) {
		const parsed = readJson<Options>(file)
		if (!parsed) throw new Error(`${CONFIG_FILE} is not valid JSON`)
		options = parsed
	}
	const dir = dataDir(cwd)
	const session = new Session({
		name: 'mocha',
		repo,
		cwd,
		dir,
		options,
		always: ALWAYS,
		digester: digester(repo),
		log,
		warn: (message) => console.error(`[blacksmith] ${message}`),
	})
	return { cwd, repo, dir, session }
}

function parseShard(value: string | undefined): Shard {
	const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
	const index = Number(match?.[1])
	const count = Number(match?.[2])
	if (!match || index < 1 || index > count) {
		throw new Error(`--shard takes <index>/<count>, e.g. 2/8; got ${value}`)
	}
	return { index, count }
}

function mochaDir(cwd: string): string {
	return path.dirname(
		createRequire(path.join(cwd, 'package.json')).resolve('mocha/package.json'),
	)
}

/** The spec files Mocha would load for these arguments and its config files, repository-relative. */
function specFiles({ cwd, repo }: Context, mochaArgs: string[]): string[] {
	const require = createRequire(path.join(cwd, 'package.json'))
	const lib = path.join(mochaDir(cwd), 'lib', 'cli')
	process.env[ENV_IN_CLI] = '1'
	const { loadOptions } = require(path.join(lib, 'options.js')) as {
		loadOptions(args: string[]): Record<string, unknown> & { _?: string[] }
	}
	const collectFiles = require(path.join(lib, 'collect-files.js')) as (
		options: Record<string, unknown>,
	) => { files: string[] } | string[]
	const options = loadOptions(mochaArgs)
	delete process.env[ENV_IN_CLI]
	const collected = collectFiles({
		ignore: options.ignore ?? [],
		extension: options.extension ?? ['js', 'cjs', 'mjs'],
		file: [],
		recursive: options.recursive ?? false,
		sort: options.sort ?? false,
		spec: options._?.length ? options._ : ['./test'],
	})
	// Mocha 10 returns the list itself.
	const files = Array.isArray(collected) ? collected : collected.files
	return files.map((file) =>
		path.relative(repo, path.resolve(cwd, file)).split(path.sep).join('/'),
	)
}

async function affected(
	ctx: Context,
	shard: Shard | null,
	mochaArgs: string[],
): Promise<Pending> {
	if (shard) {
		ctx.session.checkShard(
			shard,
			`--shard ${shard.index}/${shard.count}`,
			`raise maxShards in ${CONFIG_FILE}`,
		)
	}
	const all = specFiles(ctx, mochaArgs)
	const owned = shard
		? all.filter((spec) => shardFor(spec, shard.count) === shard.index - 1)
		: all
	const pending: Pending = { ...(await ctx.session.plan(owned, { shard })), all }
	writeJson(path.join(ctx.dir, 'pending.json'), pending)
	return pending
}

async function commit(ctx: Context, runFiles: string[]): Promise<void> {
	const pendingFile = path.join(ctx.dir, 'pending.json')
	const pending = readJson<Pending>(pendingFile)
	if (!pending) {
		throw new Error('nothing to commit: `blacksmith-mocha affected` or `run` has to come first')
	}
	const defaultRun = path.join(ctx.dir, 'run.json')
	const runs = (runFiles.length > 0 ? runFiles : [defaultRun])
		.map((file) => readJson<MochaRun>(file))
		.filter((run) => run !== null)
	// Without what every spec file entered, a change to a module reruns whatever loaded it.
	let entered: Map<string, Entered> | undefined
	// A run of nothing entered nothing, and takes nothing from what is known.
	if (runs.every((run) => run.ran)) {
		entered = new Map()
		for (const run of runs) {
			for (const [spec, file] of Object.entries(run.files)) {
				entered.set(spec, {
					ran: run.ran?.[spec],
					partial: file.all?.some((title) => !file.tests[title]) ?? false,
				})
			}
		}
	}
	const { records, anchored } = await ctx.session.commit(
		pending,
		runs.map(({ ran: _, ...run }) => run),
		entered ? { entered } : {},
	)
	rmSync(pendingFile, { force: true })
	rmSync(defaultRun, { force: true })
	const entries = Object.values(records.files)
	const vouched = entries.reduce(
		(sum, entry) =>
			sum + Object.values(entry.tests).filter((test) => test.state !== 'failed').length,
		0,
	)
	const total = entries.reduce((sum, entry) => sum + (entry.all?.length ?? 0), 0)
	log(
		`record: ${entries.length} spec file(s), ${vouched} of ${total} test(s) vouched for, ${anchored} path(s) anchored`,
	)
}

function describe(pending: Pending): void {
	const [summary = '', ...lines] = describeSelection(pending, 'spec file')
	log(summary)
	for (const line of lines) console.log(line)
}

async function main(): Promise<number> {
	const [command, ...rest] = process.argv.slice(2)
	if (command !== 'run' && command !== 'affected' && command !== 'commit') {
		console.error(USAGE)
		return 2
	}
	const ctx = await context()
	if (command === 'commit') {
		await commit(ctx, rest.map((file) => path.resolve(file)))
		return 0
	}
	const split = rest.indexOf('--')
	const own = split === -1 ? rest : rest.slice(0, split)
	const mochaArgs = split === -1 ? [] : rest.slice(split + 1)
	// An option this command does not know is refused, not ignored: a mistyped
	// one would otherwise run a different selection than the one asked for.
	const flags = command === 'run' ? ['--no-commit'] : ['--json']
	const unknown = own.find(
		(arg, index) =>
			arg !== '--shard' && own[index - 1] !== '--shard' && !flags.includes(arg),
	)
	if (unknown !== undefined) {
		console.error(`unknown option for ${command}: ${unknown}\n${USAGE}`)
		return 2
	}
	const shardAt = own.indexOf('--shard')
	const shard = shardAt === -1 ? null : parseShard(own[shardAt + 1])
	logToStderr = command === 'affected' && own.includes('--json')
	const pending = await affected(ctx, shard, mochaArgs)
	if (command === 'affected') {
		if (own.includes('--json')) console.log(JSON.stringify(pending))
		else describe(pending)
		return 0
	}
	describe(pending)
	const owned = new Set(pending.owned)
	const skip = pending.all.filter(
		(spec) => !owned.has(spec) || !pending.selection[spec]?.run,
	)
	let status = 0
	// Mocha exits 1 with "No test files found" when every spec is ignored.
	if (skip.length === pending.all.length) log('nothing to run')
	else {
		const result = spawnSync(
			process.execPath,
			[
				path.join(mochaDir(ctx.cwd), 'bin', 'mocha.js'),
				'--require',
				path.join(here, source ? 'register.ts' : 'register.js'),
				...mochaArgs,
				...skip.flatMap((spec) => [
					'--ignore',
					path.relative(ctx.cwd, path.join(ctx.repo, spec)),
				]),
			],
			{
				stdio: 'inherit',
				env: {
					...process.env,
					[ENV_RUN]: process.env[ENV_RUN] ?? path.join(ctx.dir, 'run.json'),
				},
			},
		)
		status = result.status ?? 1
	}
	if (!own.includes('--no-commit')) await commit(ctx, [])
	return status
}

main().then(
	(status) => {
		process.exitCode = status
	},
	(error: unknown) => {
		console.error(`[blacksmith] ${error instanceof Error ? error.message : String(error)}`)
		process.exitCode = 2
	},
)
