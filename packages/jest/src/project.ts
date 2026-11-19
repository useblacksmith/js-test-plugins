import { createHash } from 'node:crypto'
import {
	isPackagePath,
	manifestShape,
	packageVersion,
} from '../../shared/src/packages.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import picomatch from 'picomatch'

import {
	ENV_CACHE_URL,
	cacheMode,
	restoreBundle,
	saveBundle,
	type BundleFormat,
	type CacheKey,
} from '../../shared/src/actions-cache.ts'
import {
	anchorTree,
	headSha,
	knownPaths,
	type Tree,
} from '../../shared/src/git.ts'
import {
	RECORDS_VERSION,
	recordedPaths,
	ruleGlobs,
	type Records,
} from './core.ts'
import { dataDir, log, suffix, type Shard, type State } from './state.ts'

const USER_AGENT = '@useblacksmith/jest'
const BUNDLE_VERSION = 'blacksmith-jest-bundle-1'
const TRAVELS = /^(records|anchor)(\.\d+of\d+)?\.json$/

/** Files that shape every test without any of them reading it: a change runs everything. */
const ALWAYS = [
	'package.json',
	'tsconfig.json',
	'.swcrc',
	'.babelrc',
	'.babelrc.json',
	...['js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'json'].flatMap((extension) => [
		`jest.config.${extension}`,
		`babel.config.${extension}`,
	]),
]

export interface Anchor {
	tree: Tree
}

export function toRelative(repo: string, file: string): string {
	return path.relative(repo, file).split(path.sep).join('/')
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as T
	} catch {
		return null
	}
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
export function alwaysPaths({ cwd, repo }: State): string[] {
	const prefix = toRelative(repo, cwd)
	const workflow = workflowPath()
	return [
		...new Set([
			...ALWAYS,
			...(prefix === '' ? [] : ALWAYS.map((file) => `${prefix}/${file}`)),
			...(workflow === null ? [] : [workflow]),
		]),
	]
}

/** Repository files the `dependencies` globs name: nothing reads them, so only the anchor sees them change. */
async function ruleFiles({ repo, options }: State): Promise<string[]> {
	const globs = ruleGlobs(options)
	if (globs.length === 0) return []
	const matches = picomatch(globs, { dot: true })
	return [...(await knownPaths(repo))].filter((file) => matches(file))
}

/** The current tree of everything a change to which matters: `recorded`, the always-rerun files and the rule files. */
/**
 * The tree the anchor compares: file content for repository files, the
 * installed version for packages, and for the package.json files of `ALWAYS`
 * everything but their dependency fields. No lockfile is in it: the packages
 * a test loaded say whether an install changed anything for it.
 */
export async function currentTree(
	ctx: State,
	recorded: Iterable<string>,
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
		const shape = manifestShape(path.join(ctx.repo, file))
		if (shape !== null) tree[file] = shape
	}
	return tree
}

export const recordsFile = (ctx: State, shard: Shard | null): string =>
	path.join(dataDir(ctx.cwd), `records${suffix(shard)}.json`)
export const anchorFile = (ctx: State, shard: Shard | null): string =>
	path.join(dataDir(ctx.cwd), `anchor${suffix(shard)}.json`)

export async function writeRecords(
	ctx: State,
	shard: Shard | null,
	records: Records,
): Promise<number> {
	const tree = await currentTree(ctx, recordedPaths(records))
	mkdirSync(dataDir(ctx.cwd), { recursive: true })
	writeFileSync(recordsFile(ctx, shard), JSON.stringify(records))
	writeFileSync(
		anchorFile(ctx, shard),
		JSON.stringify({ tree } satisfies Anchor),
	)
	return Object.keys(tree).length
}

function cacheKey(
	{ cwd, repo }: State,
	shard: Shard | null,
	head: string,
): CacheKey {
	const job = `${workflowPath() ?? ''}#${process.env.GITHUB_JOB ?? ''}`
	const scope = createHash('sha1')
		.update([job, path.relative(repo, cwd)].join('\n'))
		.digest('hex')
		.slice(0, 12)
	const runtime = `node${process.versions.node.split('.')[0]}-${process.platform}-${process.arch}`
	const prefix = `blacksmith-jest-v${RECORDS_VERSION}-${runtime}-${scope}-${shard ? `${shard.index}of${shard.count}` : '1of1'}-`
	return { key: `${prefix}${head}`, prefix }
}

const FORMAT: BundleFormat = {
	version: BUNDLE_VERSION,
	userAgent: USER_AGENT,
	travels: (name) => TRAVELS.test(name),
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

/** Pulls the newest record for this shard from the Actions cache when the data directory holds none. Never fails the run. */
export async function restore(ctx: State, shard: Shard | null): Promise<void> {
	const base = process.env[ENV_CACHE_URL]
	if (!base || !cacheMode().readable) return
	if (existsSync(recordsFile(ctx, shard))) return
	try {
		const key = cacheKey(ctx, shard, await headSha(ctx.repo))
		const outcome = await restoreBundle(base, dataDir(ctx.cwd), key, FORMAT)
		log(
			outcome.restored
				? `restored dependency cache ${outcome.key}`
				: `no dependency cache: ${outcome.reason}`,
		)
	} catch (error) {
		log(`dependency cache not restored: ${message(error)}`)
	}
}

export async function save(ctx: State, shard: Shard | null): Promise<void> {
	const base = process.env[ENV_CACHE_URL]
	if (!base) return
	try {
		const key = cacheKey(ctx, shard, await headSha(ctx.repo))
		const outcome = await saveBundle(base, dataDir(ctx.cwd), key, FORMAT)
		log(
			outcome.saved
				? `saved dependency cache ${key.key} (${outcome.bytes} bytes)`
				: `dependency cache not saved: ${outcome.reason}`,
		)
	} catch (error) {
		log(`dependency cache not saved: ${message(error)}`)
	}
}
