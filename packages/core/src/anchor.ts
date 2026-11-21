import path from 'node:path'

import {
	anchorTree,
	blobsAt,
	diffTrees,
	knownPaths,
	lockfilePaths,
	pathsUnder,
	type Tree,
} from './git.ts'
import { isPackagePath, manifestShape, packageVersion } from './packages.ts'
import { LOCKFILES, isManifest, repoDir, type Rules } from './select.ts'

/**
 * The anchor: what every path a record names looked like when the record
 * was written. Comparing it with the same paths now is the only thing that
 * says a file changed, so no git history is needed, and an uncommitted
 * change counts.
 */
export interface Anchor {
	tree: Tree
	/** The commit the anchor was taken at: a path it does not name is compared with its blob there. */
	head?: string
	/** Node major, platform and arch the run was made on; another one does not share its skips. */
	runtime?: string
	/** The workflow file and job the run was part of (see `jobId`); another job's `env` and steps differ, so it does not share its skips. */
	job?: string
}

/** What tells where a run looks: the repository, the directory it runs in, and what its runner reads that no test does. */
export interface Scope {
	repo: string
	/** Where the runner runs, absolute. */
	cwd: string
	/** Names of the runner's config files, looked for in `cwd` and at the repository root: a change to one runs everything. */
	always: readonly string[]
	rules: Rules
	/** The repository-relative directory the rule globs are relative to, '' for the root. */
	rulesBase?: string
	warn(message: string): void
}

/** `file` relative to the repository with `/` (git's form, whatever `path.sep` is). */
export function toRelative(repo: string, file: string): string {
	return path.relative(repo, file).split(path.sep).join('/')
}

/**
 * The workflow file running this job, when it lives in this repository. Its
 * `matrix`, `env` and steps shape every test, so a change to it runs them all.
 */
export function workflowPath(): string | null {
	const ref = process.env.GITHUB_WORKFLOW_REF
	const repository = process.env.GITHUB_REPOSITORY
	if (!ref || !repository || !ref.startsWith(`${repository}/`)) return null
	const file = ref.slice(repository.length + 1).split('@')[0] ?? ''
	return file.startsWith('.github/workflows/') ? file : null
}

/**
 * The workflow file and job this run is part of, `.github/workflows/ci.yml#test`;
 * '' outside Actions. Two jobs run the same tests under different `env` and
 * steps, so neither trusts the other's record or restores its cache entry.
 */
export function jobId(): string {
	const workflow = workflowPath()
	const job = process.env.GITHUB_JOB
	return workflow || job ? `${workflow ?? ''}#${job ?? ''}` : ''
}

export function runtimeId(): string {
	return `node${process.versions.node.split('.')[0]}-${process.platform}-${process.arch}`
}

/** The runner's config files in the working directory and at the repository root, and the workflow file: files that shape every test without any of them reading it. */
export function alwaysPaths({ cwd, repo, always }: Scope): string[] {
	const prefix = toRelative(repo, cwd)
	const workflow = workflowPath()
	return [
		...new Set([
			...always,
			...(prefix === '' ? [] : always.map((file) => `${prefix}/${file}`)),
			...(workflow === null ? [] : [workflow]),
		]),
	]
}

/** `dir` and every parent up to the repository root, repository-relative ('' for the root). */
function ancestors(dir: string): string[] {
	const result: string[] = []
	for (let current = dir; ; ) {
		if (current === '.' || current === '') {
			result.push('')
			return result
		}
		result.push(current)
		const parent = path.posix.dirname(current)
		if (parent === current) return result
		current = parent
	}
}

const warned = new WeakMap<Rules, Set<string>>()

/**
 * Repository files the rule globs name. Git-ignored ones (generated code,
 * downloaded fixtures) are looked up under the directories the globs start
 * in, never repository-wide. A rule that names no file is warned about once.
 */
function ruleFiles(scope: Scope, candidates: ReadonlySet<string>, ignored: ReadonlySet<string>): string[] {
	const { rules } = scope
	const matched = rules.dependencies.map(() => 0)
	const files: string[] = []
	for (const file of new Set([...candidates, ...ignored])) {
		if (!rules.names(file)) continue
		files.push(file)
		rules.dependencies.forEach((rule, index) => {
			if (rule.deps(file)) matched[index] = (matched[index] ?? 0) + 1
		})
	}
	let told = warned.get(rules)
	if (!told) warned.set(rules, (told = new Set()))
	rules.dependencies.forEach((rule, index) => {
		if (matched[index] !== 0 || told.has(rule.source)) return
		told.add(rule.source)
		scope.warn(
			`dependencies["${rule.source}"] matches no file in the repository; globs are relative to ${path.join(scope.repo, scope.rulesBase ?? '')}`,
		)
	})
	return files
}

/**
 * Repository-relative paths the anchor covers: every file `recorded` names,
 * the always-rerun files, the manifests and lockfiles in the directories
 * above the recorded files, and every file a rule names (nothing reads
 * those, so the anchor is the only way a change to them is seen).
 */
async function anchoredPaths(scope: Scope, recorded: readonly string[]): Promise<string[]> {
	const paths = new Set<string>(alwaysPaths(scope))
	const dirs = new Set<string>()
	for (const file of recorded) {
		if (isPackagePath(file)) continue
		paths.add(file)
		// Outside the repository (`..`, or another drive on Windows): no manifest above it is ours.
		if (file.startsWith('..') || path.isAbsolute(file)) continue
		for (const dir of ancestors(repoDir(file))) dirs.add(dir)
	}
	// A lockfile pins what the tests below it resolve; a vendored repository's
	// or a fixture's lockfile pins nothing a test loads.
	for (const file of await lockfilePaths(scope.repo, LOCKFILES)) {
		if (dirs.has(repoDir(file))) paths.add(file)
	}
	const candidates = await knownPaths(scope.repo)
	for (const file of candidates) {
		if (isManifest(file) && dirs.has(repoDir(file))) paths.add(file)
	}
	const bases = new Set(scope.rules.dependencies.flatMap((rule) => rule.bases))
	const ignored = new Set<string>()
	for (const file of await pathsUnder(scope.repo, [...bases])) {
		if (!file.split('/').includes('node_modules')) ignored.add(file)
	}
	for (const file of ruleFiles(scope, candidates, ignored)) paths.add(file)
	return [...paths]
}

/**
 * The tree the anchor compares: file content for repository files, the
 * installed version for packages, and for a package.json no test read
 * itself everything but its dependency fields (the packages a test loaded
 * say whether an install changed anything for it).
 */
export async function currentTree(
	scope: Scope,
	recorded: Iterable<string>,
	read: ReadonlySet<string>,
): Promise<Tree> {
	const paths = [...new Set(recorded)]
	const tree = await anchorTree(scope.repo, await anchoredPaths(scope, paths))
	for (const file of paths) {
		if (!isPackagePath(file)) continue
		const version = packageVersion(path.join(scope.repo, file))
		if (version !== null) tree[file] = version
	}
	for (const file of Object.keys(tree)) {
		if (path.posix.basename(file) !== 'package.json' || isPackagePath(file)) continue
		// One a test read itself is compared in full: its dependency fields are that test's input.
		if (read.has(file)) continue
		const shape = manifestShape(path.join(scope.repo, file))
		if (shape !== null) tree[file] = shape
	}
	return tree
}

/**
 * Paths that differ from the anchor's. A path the anchor does not name (a
 * later run recorded it, or it was recorded after another shard's run) is a
 * change only if it was not tracked with the same blob at the anchor's commit.
 */
export async function changedSince(repo: string, anchor: Anchor, tree: Tree): Promise<string[]> {
	const changed = diffTrees(anchor.tree, tree)
	if (!anchor.head) return changed
	const fresh = changed.filter(
		(file) => !Object.hasOwn(anchor.tree, file) && Object.hasOwn(tree, file),
	)
	if (fresh.length === 0) return changed
	const blobs = await blobsAt(repo, anchor.head, fresh)
	if (!blobs) return changed
	return changed.filter((file) => {
		const sha = tree[file]?.split(' ')[1]
		return !(blobs.has(file) && blobs.get(file) === sha)
	})
}
