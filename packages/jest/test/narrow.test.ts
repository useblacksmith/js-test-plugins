import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { coverageFlag } from '../src/index.ts'
import { projectName } from '../src/state.ts'
import { Repo } from './harness.ts'

const ALL = ['add', 'capped', 'double', 'shout']

for (const [mode, args] of [
	['workers', ['--maxWorkers=2']],
	['in band', ['--runInBand']],
] as const) {
	describe(`narrow, ${mode}`, () => {
		let repo: Repo
		const run = (...more: string[]): string[] => {
			const result = repo.jest(...args, ...more)
			assert.equal(result.status, 0, result.output)
			return Repo.ran(result)
		}
		const edit = (file: string, from: string, to: string): void => {
			const text = repo.read(file)
			assert.ok(text.includes(from), `${file} has no ${from}`)
			repo.write(file, text.replace(from, to))
		}
		before(() => {
			repo = new Repo('narrow')
		})
		after(() => repo.cleanup())

		test('the first run runs every test file, the next none', () => {
			assert.deepEqual(run(), ALL)
			assert.deepEqual(run(), [])
		})

		test('a function body reruns the test files that entered it', () => {
			edit('src/math.js', 'return a + b', 'return b + a')
			assert.deepEqual(run(), ['add'])
			edit('src/math.js', 'n * 2', '2 * n')
			assert.deepEqual(run(), ['double'])
			edit('src/text.js', 'text.toLowerCase()', 'text.toLowerCase().trim()')
			assert.deepEqual(run(), [])
		})

		test('a change made, undone and made again reruns each time', () => {
			edit('src/math.js', 'return b + a', 'return a + b')
			assert.deepEqual(run(), ['add'])
			edit('src/math.js', 'return a + b', 'return b + a')
			assert.deepEqual(run(), ['add'])
			edit('src/math.js', 'return b + a', 'return a + b')
			assert.deepEqual(run(), ['add'])
		})

		test('a value reruns the test files that loaded a module importing it', () => {
			edit('src/limits.js', 'UNUSED = 1', 'UNUSED = 2')
			assert.deepEqual(run(), [])
			edit('src/limits.js', 'LIMIT = 10', 'LIMIT = 10 // ten')
			assert.deepEqual(run(), [])
			edit('src/limits.js', 'LIMIT = 10', 'LIMIT = 5 + 5')
			assert.deepEqual(run(), ALL)
		})

		test('a top-level statement reruns every test file that loaded the file', () => {
			repo.append('src/text.js', '\nglobalThis.loaded = true\n')
			assert.deepEqual(run(), ['add', 'shout'])
		})

		test('a run of some test files keeps the change for the others', () => {
			edit('src/math.js', 'Math.min(n, LIMIT)', 'Math.min(LIMIT, n)')
			assert.deepEqual(run('test/add.test.js'), [])
			assert.deepEqual(run(), ['capped'])
		})

		test('a run of some tests keeps what the others entered', () => {
			assert.deepEqual(run('-t', 'leaves'), [])
			edit('src/math.js', 'Math.min(LIMIT, n)', 'Math.min(n, LIMIT)')
			assert.deepEqual(run('-t', 'leaves'), ['capped'])
			edit('src/math.js', 'Math.min(n, LIMIT)', 'Math.min(LIMIT, n)')
			assert.deepEqual(run(), ['capped'])
		})

		test('a run with coverage forgets what the test files entered', () => {
			edit('src/math.js', 'return a + b', 'return b + a')
			assert.deepEqual(run('--coverage=true'), ALL)
			edit('src/math.js', 'return b + a', 'return a + b')
			assert.deepEqual(run(), ALL)
			edit('src/math.js', 'return a + b', 'return b + a')
			assert.deepEqual(run(), ['add'])
		})
	})
}

test('the command line turns off coverage the config turns on', () => {
	assert.equal(coverageFlag(['--coverage']), true)
	assert.equal(coverageFlag(['--collectCoverage=true']), true)
	assert.equal(coverageFlag(['--coverage=false']), false)
	assert.equal(coverageFlag(['--coverage', 'false']), false)
	assert.equal(coverageFlag(['--no-coverage']), false)
	assert.equal(coverageFlag(['--coverage', '--no-coverage']), false)
	assert.equal(coverageFlag(['--no-coverage', '--coverage']), true)
	assert.equal(coverageFlag(['--runInBand']), undefined)
})

test('two projects without a name on one rootDir have a name each', () => {
	const a = projectName({ id: 'one', rootDir: '/repo' }, '/repo')
	const b = projectName({ id: 'two', rootDir: '/repo' }, '/repo')
	assert.notEqual(a, b)
	assert.equal(projectName({ displayName: 'unit', id: 'one' }, '/repo'), 'unit')
	assert.equal(
		projectName({ displayName: { name: 'unit' }, id: 'one' }, '/repo'),
		'unit',
	)
})

describe('a test file two projects run', () => {
	let repo: Repo
	before(() => {
		repo = new Repo('narrow')
		const project = (name: string): string =>
			`{ displayName: '${name}', rootDir: __dirname, testMatch: ['**/test/which.test.js'], transform: { '\\\\.js$': '<rootDir>/esm-transformer.js' }, moduleNameMapper: { '^lib$': '<rootDir>/src/lib-${name}.js' } }`
		repo.write(
			'jest.config.js',
			`const { withBlacksmith } = require(process.env.BLACKSMITH_JEST_ENTRY)\nmodule.exports = withBlacksmith({ projects: [${project('a')}, ${project('b')}] })\n`,
		)
		repo.write('src/lib-a.js', 'export const which = () => 1\n')
		repo.write('src/lib-b.js', 'export const which = () => 1\n')
		repo.write(
			'test/which.test.js',
			"import { which } from 'lib'\ntest('which', () => expect(which()).toBe(1))\n",
		)
		repo.git('add', '-A')
		repo.git('commit', '-q', '-m', 'projects')
	})
	after(() => repo.cleanup())

	/** The projects whose copy of the test file a run passed. */
	const passed = (output: string): string[] =>
		[...output.matchAll(/^PASS (\w+) test\/which\.test\.js$/gm)]
			.map((match) => match[1] ?? '')
			.sort()

	test('records what it loaded in each project, a row per project', () => {
		const result = repo.jest('--runInBand')
		assert.equal(result.status, 0, result.output)
		const { files } = repo.records()
		for (const [name, other] of [
			['a', 'b'],
			['b', 'a'],
		]) {
			const deps = files[`test/which.test.js\0${name}`]?.deps ?? []
			assert.ok(deps.includes(`src/lib-${name}.js`), deps.join())
			assert.ok(!deps.includes(`src/lib-${other}.js`), deps.join())
		}
		assert.equal(files['test/which.test.js'], undefined)
	})

	for (const name of ['a', 'b']) {
		test(`reruns in project ${name} alone for a change only it resolves`, () => {
			repo.write(`src/lib-${name}.js`, 'export const which = () => 2 - 1\n')
			const result = repo.jest('--runInBand')
			assert.equal(result.status, 0, result.output)
			assert.deepEqual(passed(result.output), [name])
		})
	}

	test('two shards each run it in a project of their own, and rerun it for their own project alone', () => {
		const shards = (): string[][] =>
			[1, 2].map((shard) => {
				const result = repo.jest(
					'--runInBand',
					'--shard',
					`${shard}/2`,
					'--passWithNoTests',
				)
				assert.equal(result.status, 0, result.output)
				return passed(result.output)
			})
		// Jest gives each shard one of the two copies.
		const first = shards()
		assert.deepEqual(first.flat().sort(), ['a', 'b'])
		assert.deepEqual(first.map((names) => names.length), [1, 1])
		assert.deepEqual(shards(), [[], []])
		repo.write('src/lib-b.js', 'export const which = () => 3 - 2\n')
		assert.deepEqual(
			shards(),
			first.map((names) => names.filter((name) => name === 'b')),
		)
		assert.deepEqual(shards(), [[], []])
	})
})
