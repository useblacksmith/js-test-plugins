import assert from 'node:assert/strict'

import { fakeCacheService } from './fake-cache.ts'
import { type Driver, Project, testFile, WORKFLOW_FILE } from './project.ts'

/**
 * End-to-end cases every plugin must pass: the sample project, run with the
 * real test runner, a change, and which test files the next run executes.
 * Each plugin's test suite registers them with its own driver.
 */

const ALL = ['a', 'b', 'c']

interface Scenario {
	name: string
	/** Only for a plugin that tracks installed packages, or only for one that does not. */
	packages?: boolean
	/** Only for a plugin whose shards read the records of every shard. */
	shards?: true
	/** Only meaningful when the record travels through a cache. */
	cacheOnly?: true
	run(project: Project, cached: boolean): Promise<void>
}

/** The first run of a project: everything runs and passes. */
async function first(project: Project) {
	const run = await project.run()
	assert.equal(run.status, 0, run.output)
	assert.deepEqual(run.ran, ALL, run.output)
	return run
}

/** A run that must pass and execute exactly `ran`. */
async function expectRun(project: Project, ran: string[]) {
	const run = await project.run()
	assert.equal(run.status, 0, run.output)
	assert.deepEqual(run.ran, ran, run.output)
	return run
}

/** After `change`, the next run executes `ran` and the one after it nothing. */
function reruns(
	name: string,
	change: (project: Project) => void,
	ran: string[],
): Scenario {
	return {
		name,
		async run(project) {
			await first(project)
			change(project)
			await expectRun(project, ran)
			await expectRun(project, [])
		},
	}
}

const USED = 'used-package'
const UNUSED = 'unused-package'

/** The sample with two installed packages, one of which the test file `used-package` loads; everything has run once. */
async function withPackages(project: Project): Promise<void> {
	project.install(USED, '1.0.0')
	project.install(UNUSED, '1.0.0')
	project.change(`test/${USED}.test.js`, project.packageTest(USED))
	const run = await project.run()
	assert.equal(run.status, 0, run.output)
	assert.deepEqual(run.ran, [...ALL, USED], run.output)
}

/** What an install does: a new version in node_modules and a changed lockfile. */
function bump(project: Project, name: string): void {
	project.install(name, '1.1.0')
	project.change('package-lock.json', `{ "bumped": "${name}" }\n`)
}

function packageScenarios(): Scenario[] {
	return [
		{
			name: 'a new version of a package reruns the test files that loaded it',
			packages: true,
			async run(project) {
				await withPackages(project)
				bump(project, USED)
				await expectRun(project, [USED])
				await expectRun(project, [])
			},
		},
		{
			name: 'a new version of a package that a loaded package loads in turn reruns the test file',
			packages: true,
			async run(project) {
				await withPackages(project)
				// `used-package` now requires `unused-package`, as a transitive dependency.
				project.write(
					`node_modules/${USED}/index.js`,
					`require(${JSON.stringify(UNUSED)})\nmodule.exports = () => ${JSON.stringify(USED)}\n`,
				)
				project.install(USED, '1.0.1')
				project.write(
					`node_modules/${USED}/index.js`,
					`require(${JSON.stringify(UNUSED)})\nmodule.exports = () => ${JSON.stringify(USED)}\n`,
				)
				await expectRun(project, [USED])
				bump(project, UNUSED)
				await expectRun(project, [USED])
				await expectRun(project, [])
			},
		},
		{
			name: 'a copy of a package installed nearer to the file that loads it reruns the test files that loaded the other copy',
			packages: true,
			async run(project) {
				project.install(USED, '1.0.0')
				// A workspace that takes the package from the root, as a hoisting install lays it out.
				project.write(
					'packages/near/index.js',
					project.driver.style === 'esm'
						? `import loaded from '${USED}'\nexport default loaded\n`
						: `module.exports = require('${USED}')\n`,
				)
				project.write('packages/near/package.json', '{ "name": "near", "private": true }\n')
				project.write(
					`test/${USED}.test.js`,
					project.packageTest('../packages/near/index.js', USED),
				)
				project.commit('load a package from a workspace')
				await expectRun(project, [...ALL, USED])
				// The workspace asks for another version: the root keeps its copy.
				project.install(USED, '2.0.0', 'packages/near')
				project.change('package-lock.json', '{ "nested": true }\n')
				await expectRun(project, [USED])
				await expectRun(project, [])
				// And back: the nearer copy is gone.
				project.remove(`packages/near/node_modules`)
				project.change('package-lock.json', '{ "nested": false }\n')
				await expectRun(project, [USED])
				await expectRun(project, [])
			},
		},
		{
			name: 'a copy of a package installed inside the package that loads it reruns the test files that loaded that package',
			packages: true,
			async run(project) {
				project.install(USED, '1.0.0')
				project.install(UNUSED, '1.0.0')
				project.write(
					`node_modules/${USED}/index.js`,
					`require(${JSON.stringify(UNUSED)})\nmodule.exports = () => ${JSON.stringify(USED)}\n`,
				)
				project.change(`test/${USED}.test.js`, project.packageTest(USED))
				await expectRun(project, [...ALL, USED])
				// Its dependency no longer fits the copy at the root: neither version there changes.
				project.install(UNUSED, '2.0.0', `node_modules/${USED}`)
				project.change('package-lock.json', '{ "nested": true }\n')
				await expectRun(project, [USED])
				await expectRun(project, [])
			},
		},
		{
			name: 'a new version of a package no test loaded reruns nothing',
			packages: true,
			async run(project) {
				await withPackages(project)
				bump(project, UNUSED)
				await expectRun(project, [])
			},
		},
		{
			name: 'a package.json change to its dependency fields alone reruns nothing',
			packages: true,
			async run(project) {
				await withPackages(project)
				const manifest = JSON.parse(project.read('package.json')) as object
				project.change(
					'package.json',
					`${JSON.stringify({ ...manifest, dependencies: { [UNUSED]: '^1.1.0' } }, null, 2)}\n`,
				)
				await expectRun(project, [])
			},
		},
		{
			name: 'a package.json change to its dependency fields reruns everything once a test read the file itself',
			packages: true,
			async run(project) {
				project.change(
					'test/manifest.test.js',
					project.readingTest('manifest', 'package.json'),
				)
				const run = await project.run()
				assert.deepEqual(run.ran, [...ALL, 'manifest'], run.output)
				const manifest = JSON.parse(project.read('package.json')) as object
				project.change(
					'package.json',
					`${JSON.stringify({ ...manifest, dependencies: { some: '^1.0.0' } }, null, 2)}\n`,
				)
				await expectRun(project, [...ALL, 'manifest'])
			},
		},
		{
			name: 'a package.json change to its dependency fields reruns a test that read the file through a helper package',
			packages: true,
			async run(project) {
				project.change(
					'test/helped.test.js',
					project.helperReadingTest('helped', 'read-helper', 'package.json'),
				)
				const run = await project.run()
				assert.deepEqual(run.ran, [...ALL, 'helped'].sort(), run.output)
				const manifest = JSON.parse(project.read('package.json')) as object
				project.change(
					'package.json',
					`${JSON.stringify({ ...manifest, dependencies: { some: '^1.0.0' } }, null, 2)}\n`,
				)
				const next = await project.run()
				assert.ok(next.ran.includes('helped'), next.output)
			},
		},
		{
			name: 'a new version of a package a test reads a file of, or loads in a child process, reruns that test file',
			packages: true,
			async run(project) {
				project.install(USED, '1.0.0')
				project.install(UNUSED, '1.0.0')
				project.change(
					'test/asset.test.js',
					project.readingTest('asset', `node_modules/${USED}/index.js`),
				)
				project.change('test/spawn.test.js', project.spawningTest('spawn', UNUSED))
				const run = await project.run()
				assert.deepEqual(run.ran, [...ALL, 'asset', 'spawn'].sort(), run.output)
				bump(project, USED)
				await expectRun(project, ['asset'])
				bump(project, UNUSED)
				await expectRun(project, ['spawn'])
			},
		},
		{
			name: 'a new version of a package the config loaded reruns everything',
			packages: true,
			async run(project) {
				const { withTool } = project.driver
				if (!withTool) return
				project.install(USED, '1.0.0')
				for (const [file, content] of Object.entries(
					withTool.call(project.driver, project.plugin, USED),
				)) {
					project.write(file, content)
				}
				project.commit('load a package from the config')
				await first(project)
				bump(project, USED)
				await expectRun(project, ALL)
				await expectRun(project, [])
			},
		},
	]
}

export const scenarios: Scenario[] = [
	{
		name: 'the first run runs every test file',
		async run(project, cached) {
			const run = await first(project)
			if (cached) {
				assert.match(run.output, /no dependency cache/)
				assert.match(run.output, /saved dependency cache/)
			}
		},
	},
	{
		name: 'an unchanged tree runs nothing',
		async run(project, cached) {
			await first(project)
			const run = await expectRun(project, [])
			if (cached) assert.match(run.output, /restored dependency cache/)
		},
	},
	reruns(
		'a changed module reruns the test files that load it',
		(project) =>
			project.change('src/b.js', `${project.read('src/b.js')}globalThis.edited = true\n`),
		['a', 'b'],
	),
	reruns(
		'a changed file reruns the test file that read it while running',
		(project) => project.change('data/c.txt', 'ok\nmore\n'),
		['c'],
	),
	reruns(
		'a changed file no test uses reruns nothing',
		(project) => project.change('README.md', '# sample\n\nedit\n'),
		[],
	),
	reruns(
		'a package.json change reruns everything',
		(project) => {
			const manifest = JSON.parse(project.read('package.json')) as object
			project.change(
				'package.json',
				`${JSON.stringify({ ...manifest, description: 'edit' }, null, 2)}\n`,
			)
		},
		ALL,
	),
	{
		...reruns(
			'a lockfile change reruns everything',
			(project) =>
				project.change(
					'package-lock.json',
					`${project.read('package-lock.json')}\n`,
				),
			ALL,
		),
		packages: false,
	},
	...packageScenarios(),
	{
		name: 'a run on another shard count reruns nothing, and a change reruns its test files on one shard',
		shards: true,
		cacheOnly: true,
		async run(project) {
			const shards = async (count: number): Promise<string[]> => {
				const ran: string[] = []
				for (let index = 1; index <= count; index++) {
					project.shard = `${index}/${count}`
					const run = await project.run()
					assert.equal(run.status, 0, run.output)
					ran.push(...run.ran)
				}
				project.shard = null
				return ran.sort()
			}
			assert.deepEqual(await shards(2), ALL)
			assert.deepEqual(await shards(3), [])
			await expectRun(project, [])
			project.change('src/b.js', `${project.read('src/b.js')}globalThis.edited = true\n`)
			assert.deepEqual(await shards(3), ['a', 'b'])
			assert.deepEqual(await shards(2), [])
			await expectRun(project, [])
		},
	},
	reruns(
		'a change to the workflow running the job reruns everything',
		(project) =>
			project.change(WORKFLOW_FILE, `${project.read(WORKFLOW_FILE)}# edit\n`),
		ALL,
	),
	reruns(
		'a new test file runs alone',
		(project) =>
			project.change('test/d.test.js', testFile(project.driver, 'b', 'b')),
		['d'],
	),
	{
		name: 'a test file that failed on one shard reruns on another shard count, whatever the other shards hold of it',
		shards: true,
		cacheOnly: true,
		async run(project) {
			const shards = async (count: number): Promise<string[]> => {
				const ran: string[] = []
				for (let index = 1; index <= count; index++) {
					project.shard = `${index}/${count}`
					ran.push(...(await project.run()).ran)
				}
				project.shard = null
				return ran.sort()
			}
			assert.deepEqual(await shards(2), ALL)
			// Every shard now saves the three test files.
			assert.deepEqual(await shards(3), [])
			project.change('data/c.txt', 'broken\n')
			assert.deepEqual(await shards(3), ['c'])
			assert.deepEqual(await shards(2), ['c'])
			const failed = await project.run()
			assert.notEqual(failed.status, 0, failed.output)
			assert.deepEqual(failed.ran, ['c'], failed.output)
			project.change('data/c.txt', 'ok\nfixed\n')
			assert.deepEqual(await shards(2), ['c'])
			assert.deepEqual(await shards(3), [])
		},
	},
	{
		name: 'a run split into more shards than maxShards fails',
		shards: true,
		async run(project) {
			project.shard = '1/21'
			const run = await project.run()
			assert.notEqual(run.status, 0, run.output)
			assert.match(run.output, /maxShards \(20\)/)
			assert.deepEqual(run.ran, [], run.output)
		},
	},
	{
		name: 'an uncommitted change reruns its test files',
		async run(project) {
			await first(project)
			project.write('src/b.js', `${project.read('src/b.js')}globalThis.edited = true\n`)
			await expectRun(project, ['a', 'b'])
		},
	},
	{
		name: 'a failed test file reruns until it passes',
		async run(project) {
			await first(project)
			project.change('data/c.txt', 'broken\n')
			for (const _ of [1, 2]) {
				const failed = await project.run()
				assert.notEqual(failed.status, 0, failed.output)
				assert.deepEqual(failed.ran, ['c'], failed.output)
			}
			// Not the first content again: a tree identical to one that passed may
			// restore that run's record, and skipping the test file is then right.
			project.change('data/c.txt', 'ok\nfixed\n')
			await expectRun(project, ['c'])
			await expectRun(project, [])
		},
	},
	{
		name: 'an empty cache runs everything',
		cacheOnly: true,
		async run(project) {
			await first(project)
			// Another job: no entry of this one is restored.
			project.job += '-other'
			const run = await first(project)
			assert.match(run.output, /no dependency cache/)
		},
	},
	{
		name: 'a read-only cache restores and saves nothing',
		cacheOnly: true,
		async run(project) {
			await first(project)
			project.change('src/b.js', `${project.read('src/b.js')}globalThis.edited = true\n`)
			project.env.ACTIONS_CACHE_MODE = 'read'
			for (const _ of [1, 2]) {
				const run = await expectRun(project, ['a', 'b'])
				assert.match(run.output, /restored dependency cache/)
				assert.match(run.output, /not saved/)
			}
			delete project.env.ACTIONS_CACHE_MODE
			await expectRun(project, ['a', 'b'])
			await expectRun(project, [])
		},
	},
]

export interface Case {
	name: string
	run(): Promise<void>
}

/**
 * The cases to register for `driver`: every scenario with the record on disk,
 * and again with it travelling through a cache. The cache is a fake in this
 * process, or the job's real one under BLACKSMITH_E2E_CACHE=real.
 */
export function cases(driver: Driver): Case[] {
	const real = process.env.BLACKSMITH_E2E_CACHE === 'real'
	const modes = [
		{ label: 'record on disk', cached: false },
		{ label: real ? 'real Actions cache' : 'fake Actions cache', cached: true },
	]
	return modes.flatMap(({ label, cached }) =>
		scenarios
			.filter((scenario) => cached || !scenario.cacheOnly)
			.filter((scenario) => !scenario.shards || driver.mergesShards === true)
			.filter(
				(scenario) =>
					scenario.packages === undefined ||
					scenario.packages === (driver.tracksPackages === true),
			)
			.map((scenario) => ({
				name: `${label}: ${scenario.name}`,
				async run() {
					const fake = cached && !real ? await fakeCacheService() : null
					const url = fake?.url ?? process.env.ACTIONS_RESULTS_URL
					if (cached && !url) {
						throw new Error('ACTIONS_RESULTS_URL is not set: no real cache')
					}
					const project = new Project(driver, cached ? url : undefined)
					try {
						await scenario.run(project, cached)
					} finally {
						project.cleanup()
						fake?.close()
					}
				},
			})),
	)
}
