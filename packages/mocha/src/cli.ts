#!/usr/bin/env node
import {
	isPackagePath,
	manifestShape,
	packageVersion,
} from '../../shared/src/packages.ts'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import picomatch from 'picomatch'

import {
	ENV_CACHE_URL,
	cacheMode,
	restoreBundle,
	saveBundle,
	type BundleFormat,
	type CacheKey,
} from '../../shared/src/actions-cache.ts'
import { ENV_REPO } from '../../shared/src/fs-recorder.ts'
import {
	anchorTree,
	diffTrees,
	headSha,
	knownPaths,
	repoRoot,
	type Tree,
} from '../../shared/src/git.ts'
import { shardFor } from '../../shared/src/shard.ts'
import {
	RECORDS_VERSION,
	mergeRecords,
	recordedPaths,
	ruleGlobs,
	select,
	type Decision,
	type Options,
	type Records,
	type RunRecord,
} from './core.ts'
import { ENV_IN_CLI, ENV_RUN, dataDir, suffix, type Shard } from './paths.ts'

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
const USER_AGENT = '@useblacksmith/mocha'
const BUNDLE_VERSION = 'blacksmith-mocha-bundle-1'
const TRAVELS = /^(records|anchor)(\.\d+of\d+)?\.json$/

/** Files that shape every test without any of them reading it: a change runs everything. */
const ALWAYS = [
	'package.json',
	'tsconfig.json',
	'.mocharc.cjs',
	'.mocharc.js',
	'.mocharc.yaml',
	'.mocharc.yml',
	'.mocharc.jsonc',
	'.mocharc.json',
	CONFIG_FILE,
]

interface Anchor {
	tree: Tree
}

/** What `affected` decided, kept for the `commit` that follows the run. */
interface Pending {
	shard: Shard | null
	/** Every spec file Mocha would load, repository-relative. */
	all: string[]
	/** Those this shard owns. */
	owned: string[]
	changed: string[]
	selection: Record<string, Decision>
}

interface Context {
	cwd: string
	repo: string
	dir: string
	options: Options
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

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as T
	} catch {
		return null
	}
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
	return { cwd, repo, dir: dataDir(cwd), options }
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

/** Repository files the `dependencies` and `services` globs name: nothing reads them, so only the anchor sees them change. */
async function ruleFiles({ repo, options }: Context): Promise<string[]> {
	const globs = ruleGlobs(options)
	if (globs.length === 0) return []
	const matches = picomatch(globs, { dot: true })
	return [...(await knownPaths(repo))].filter((file) => matches(file))
}

/** The workflow file running this job, when it lives in this repository. */
function workflowPath(): string | null {
	const ref = process.env.GITHUB_WORKFLOW_REF
	const repository = process.env.GITHUB_REPOSITORY
	if (!ref || !repository || !ref.startsWith(`${repository}/`)) return null
	const file = ref.slice(repository.length + 1).split('@')[0] ?? ''
	return file.startsWith('.github/workflows/') ? file : null
}

/** `ALWAYS` in the working directory and at the repository root, and the workflow file. */
function alwaysPaths({ cwd, repo }: Context): string[] {
	const prefix = path.relative(repo, cwd).split(path.sep).join('/')
	const workflow = workflowPath()
	return [
		...new Set([
			...ALWAYS,
			...(prefix === '' ? [] : ALWAYS.map((file) => `${prefix}/${file}`)),
			...(workflow === null ? [] : [workflow]),
		]),
	]
}

/**
 * The tree the anchor compares: file content for repository files, the
 * installed version for packages, and for the package.json files of `ALWAYS`
 * everything but their dependency fields. No lockfile is in it: the packages
 * a test loaded say whether an install changed anything for it.
 */
async function currentTree(
	ctx: Context,
	recorded: Iterable<string>,
	read: ReadonlySet<string>,
): Promise<Tree> {
	const paths = [...recorded]
	const always = alwaysPaths(ctx)
	const tree = await anchorTree(ctx.repo, [
		...paths.filter((file) => !isPackagePath(file)),
		...always,
		...(await ruleFiles(ctx)),
	])
	for (const file of paths) {
		if (!isPackagePath(file)) continue
		const version = packageVersion(path.join(ctx.repo, file))
		if (version !== null) tree[file] = version
	}
	for (const file of always) {
		if (path.posix.basename(file) !== 'package.json' || !(file in tree)) continue
		// One a test read itself is compared in full: its dependency fields are that test's input.
		if (read.has(file)) continue
		const shape = manifestShape(path.join(ctx.repo, file))
		if (shape !== null) tree[file] = shape
	}
	return tree
}

function cacheKey(
	{ cwd, repo }: Context,
	shard: Shard | null,
	head: string,
): CacheKey {
	const job = `${workflowPath() ?? ''}#${process.env.GITHUB_JOB ?? ''}`
	const scope = createHash('sha1')
		.update([job, path.relative(repo, cwd)].join('\n'))
		.digest('hex')
		.slice(0, 12)
	const runtime = `node${process.versions.node.split('.')[0]}-${process.platform}-${process.arch}`
	const prefix = `blacksmith-mocha-v${RECORDS_VERSION}-${runtime}-${scope}-${shard ? `${shard.index}of${shard.count}` : '1of1'}-`
	return { key: `${prefix}${head}`, prefix }
}

const FORMAT: BundleFormat = {
	version: BUNDLE_VERSION,
	userAgent: USER_AGENT,
	travels: (name) => TRAVELS.test(name),
}

/** Pulls the newest record for this shard from the Actions cache when the data directory holds none. Never fails the run. */
async function restore(ctx: Context, shard: Shard | null): Promise<void> {
	const base = process.env[ENV_CACHE_URL]
	if (!base || !cacheMode().readable) return
	if (existsSync(path.join(ctx.dir, `records${suffix(shard)}.json`))) return
	try {
		const key = cacheKey(ctx, shard, await headSha(ctx.repo))
		const outcome = await restoreBundle(base, ctx.dir, key, FORMAT)
		log(
			outcome.restored
				? `restored dependency cache ${outcome.key}`
				: `no dependency cache: ${outcome.reason}`,
		)
	} catch (error) {
		log(`dependency cache not restored: ${error instanceof Error ? error.message : String(error)}`)
	}
}

async function save(ctx: Context, shard: Shard | null): Promise<void> {
	const base = process.env[ENV_CACHE_URL]
	if (!base) return
	try {
		const key = cacheKey(ctx, shard, await headSha(ctx.repo))
		const outcome = await saveBundle(base, ctx.dir, key, FORMAT)
		log(
			outcome.saved
				? `saved dependency cache ${key.key} (${outcome.bytes} bytes)`
				: `dependency cache not saved: ${outcome.reason}`,
		)
	} catch (error) {
		log(`dependency cache not saved: ${error instanceof Error ? error.message : String(error)}`)
	}
}

async function affected(
	ctx: Context,
	shard: Shard | null,
	mochaArgs: string[],
): Promise<Pending> {
	await restore(ctx, shard)
	const all = specFiles(ctx, mochaArgs)
	const owned = shard
		? all.filter((spec) => shardFor(spec, shard.count) === shard.index - 1)
		: all
	const records = readJson<Records>(
		path.join(ctx.dir, `records${suffix(shard)}.json`),
	)
	const anchor = readJson<Anchor>(
		path.join(ctx.dir, `anchor${suffix(shard)}.json`),
	)
	const everything = (reason: string): Record<string, Decision> =>
		Object.fromEntries(owned.map((spec) => [spec, { run: true, reason }]))
	let changed: string[] = []
	let selection: Record<string, Decision>
	if (records?.version !== RECORDS_VERSION || !anchor?.tree) {
		selection = everything('no record')
	} else {
		changed = diffTrees(
			anchor.tree,
			await currentTree(
				ctx,
				Object.keys(anchor.tree),
				recordedPaths(records),
			),
		)
		const always = new Set(alwaysPaths(ctx))
		const trigger = changed.find((file) => always.has(file))
		selection =
			trigger !== undefined
				? everything(`changed: ${trigger}`)
				: select(records, owned, changed, ctx.options)
	}
	const pending: Pending = { shard, all, owned, changed, selection }
	mkdirSync(ctx.dir, { recursive: true })
	writeFileSync(path.join(ctx.dir, 'pending.json'), JSON.stringify(pending))
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
		.map((file) => readJson<RunRecord>(file))
		.filter((run) => run !== null)
	const recordsFile = path.join(ctx.dir, `records${suffix(pending.shard)}.json`)
	// A changed lockfile or config is in no test's dependencies, yet stales every
	// record: a test this run left out (`--grep`, `--bail`) keeps none.
	const always = new Set(alwaysPaths(ctx))
	const staleAll = pending.changed.some((file) => always.has(file))
	const merged = mergeRecords(
		staleAll ? null : readJson<Records>(recordsFile),
		runs,
		pending.changed,
		ctx.options,
	)
	// A spec another shard owns, or one that no longer exists, is not this record's to vouch for.
	const owned = new Set(pending.owned)
	for (const spec of Object.keys(merged.files)) {
		if (!owned.has(spec)) delete merged.files[spec]
	}
	const tree = await currentTree(ctx, recordedPaths(merged), recordedPaths(merged))
	writeFileSync(recordsFile, JSON.stringify(merged))
	writeFileSync(
		path.join(ctx.dir, `anchor${suffix(pending.shard)}.json`),
		JSON.stringify({ tree } satisfies Anchor),
	)
	rmSync(pendingFile, { force: true })
	rmSync(defaultRun, { force: true })
	const entries = Object.values(merged.files)
	const vouched = entries.reduce(
		(sum, entry) =>
			sum +
			Object.values(entry.tests).filter((test) => test.state !== 'failed').length,
		0,
	)
	const total = entries.reduce((sum, entry) => sum + entry.all.length, 0)
	log(`record: ${entries.length} spec file(s), ${vouched} of ${total} test(s) vouched for, ${Object.keys(tree).length} path(s) anchored`)
	await save(ctx, pending.shard)
}

function describe(pending: Pending): void {
	const entries = Object.entries(pending.selection)
	const affectedSpecs = entries.filter(([, decision]) => decision.run)
	const shard = pending.shard
		? ` in shard ${pending.shard.index}/${pending.shard.count}`
		: ''
	const changed =
		pending.changed.length > 0
			? `; changed: ${pending.changed.slice(0, 10).join(', ')}${pending.changed.length > 10 ? `, and ${pending.changed.length - 10} more` : ''}`
			: ''
	log(`${affectedSpecs.length} of ${entries.length} spec file(s) affected${shard}${changed}`)
	for (const [spec, decision] of affectedSpecs) {
		if (!decision.run) continue
		const tests = decision.tests
			? `${decision.tests.length} of its tests: `
			: ''
		console.log(`  run  ${spec}  (${tests}${decision.reason})`)
	}
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
