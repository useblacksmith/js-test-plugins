import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { Repo } from './harness.ts'

const ALL = ['a', 'b', 'c', 'child']

for (const [mode, args] of [
	['workers', ['--maxWorkers=2']],
	['in band', ['--runInBand']],
	['worker threads', ['--maxWorkers=2', '--workerThreads']],
] as const) {
	describe(`records and selects, ${mode}`, () => {
		let repo: Repo
		before(() => {
			repo = new Repo('basic')
		})
		after(() => repo.cleanup())

		test('the first run runs every test file and records what each loaded', () => {
			const result = repo.jest(...args)
			assert.equal(result.status, 0, result.output)
			assert.deepEqual(Repo.ran(result), ALL)
			const records = repo.records()
			const deps = (spec: string): string[] =>
				(records.files[spec]?.deps ?? []).filter(
					(file) =>
						/^(src|db)\//.test(file) && !/\.babel|package\.json/.test(file),
				)
			assert.deepEqual(deps('test/a.test.js'), [
				'src/a.js',
				'src/b.js',
				'src/data.json',
			])
			assert.deepEqual(deps('test/b.test.js'), ['src/b.js'])
			assert.deepEqual(deps('test/c.test.js'), ['src/c.js'])
			assert.deepEqual(deps('test/child.test.js'), [
				'src/child-data.txt',
				'src/child.js',
			])
			assert.deepEqual(
				records.global.filter((file) => !/babel|browsers?list/.test(file)),
				[
					'config-helper.js',
					'db/seed.txt',
					'global-setup.js',
					'jest.config.js',
					'src/setup-dep.js',
				],
			)
		})

		test('an unchanged tree runs nothing and passes', () => {
			const result = repo.jest(...args)
			assert.equal(result.status, 0, result.output)
			assert.deepEqual(Repo.ran(result), [])
		})

		test('a file a test read reruns that test file alone', () => {
			repo.write('src/data.json', '{"v":1,"w":2}')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ['a'])
		})

		test('a module two test files import reruns both', () => {
			repo.append('src/b.js', '// edit\n')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ['a', 'b'])
		})

		test('a file a child process read reruns the test file that started it', () => {
			repo.write('src/child-data.txt', 'hello\n\n')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ['child'])
		})

		test('a file added beside the modules reruns nothing', () => {
			repo.write('src/unrelated.js', 'module.exports = 0\n')
			assert.deepEqual(Repo.ran(repo.jest(...args)), [])
		})

		test('a file the `dependencies` option maps reruns the test files it names', () => {
			repo.append('db/schema.sql', '-- edit\n')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ['c'])
		})

		test('what globalSetup loads or reads, and what the config imports, reruns everything', () => {
			for (const file of ['src/setup-dep.js', 'config-helper.js']) {
				repo.append(file, '// edit\n')
				assert.deepEqual(Repo.ran(repo.jest(...args)), ALL)
			}
			repo.append('db/seed.txt', 'more\n')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ALL)
		})

		test('a run of some test files keeps the transformer configs the others looked up', () => {
			repo.append('src/c.js', '// edit\n')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ['c'])
			assert.ok(
				repo.records().global.includes('db/.babelrc.json') ||
					repo.records().global.includes('test/.babelrc.json'),
			)
			const before = repo.records().global.length
			repo.append('src/child-data.txt', '\n')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ['child'])
			assert.equal(repo.records().global.length, before)
		})

		test('a transformer config that was looked for and not found reruns everything once it exists', () => {
			repo.write('src/.babelrc.json', '{}')
			assert.deepEqual(Repo.ran(repo.jest(...args)), ALL)
			assert.deepEqual(Repo.ran(repo.jest(...args)), [])
		})
	})
}

describe('failures and partial runs', () => {
	let repo: Repo
	before(() => {
		repo = new Repo('basic')
		assert.equal(repo.jest().status, 0)
	})
	after(() => repo.cleanup())

	test('a failed test file runs again until it passes', () => {
		repo.write('src/c.js', 'module.exports = 5\n')
		const failed = repo.jest()
		assert.equal(failed.status, 1)
		assert.deepEqual(Repo.ran(failed), ['c'])
		const again = repo.jest()
		assert.equal(again.status, 1)
		assert.deepEqual(Repo.ran(again), ['c'])
		assert.match(again.lines.join('\n'), /failed last time/)
		repo.write('src/c.js', 'module.exports = 3\n')
		assert.deepEqual(Repo.ran(repo.jest()), ['c'])
		assert.deepEqual(Repo.ran(repo.jest()), [])
	})

	test('a file run in part with -t after a change stays selected', () => {
		repo.append('src/c.js', '// edit\n')
		const partial = repo.jest('-t', 'c one')
		assert.equal(partial.status, 0, partial.output)
		assert.deepEqual(Repo.ran(partial), ['c'])
		assert.deepEqual(repo.records().files['test/c.test.js']?.tests, {
			'c one': 'passed',
		})
		assert.deepEqual(Repo.ran(repo.jest()), ['c'])
		assert.deepEqual(Repo.ran(repo.jest()), [])
	})

	test('a passing -t run does not clear a failure outside the tests', () => {
		repo.write(
			'test/c.test.js',
			`${repo.read('test/c.test.js')}\nafterAll(() => {\n\tif (!process.env.HEAL) throw new Error('teardown')\n})\n`,
		)
		assert.equal(repo.jest().status, 1)
		repo.env.HEAL = '1'
		assert.equal(repo.jest('-t', 'c one').status, 0)
		assert.deepEqual(Repo.ran(repo.jest()), ['c'])
		assert.deepEqual(Repo.ran(repo.jest()), [])
	})

	test('a -t run of an unchanged file keeps its record', () => {
		const partial = repo.jest('-t', 'c one', 'test/c.test.js')
		assert.equal(partial.status, 0, partial.output)
		assert.deepEqual(Repo.ran(repo.jest()), [])
	})

	test('a test file a run leaves out after a change has no record', () => {
		repo.append('src/b.js', '// edit\n')
		assert.deepEqual(Repo.ran(repo.jest('test/a.test.js')), ['a'])
		assert.deepEqual(Repo.ran(repo.jest()), ['b'])
	})

	test('a package.json change outside its dependency fields runs everything and drops the record of a file left out', () => {
		repo.write('package.json', '{ "name": "basic", "description": "edit" }\n')
		assert.deepEqual(Repo.ran(repo.jest('test/a.test.js')), ['a'])
		assert.deepEqual(Repo.ran(repo.jest()), ['b', 'c', 'child'])
	})

	test('coverage runs everything', () => {
		const result = repo.jest('--coverage')
		assert.equal(result.status, 0, result.output)
		assert.deepEqual(Repo.ran(result), ALL)
	})

	test('a run that matches no test file still fails', () => {
		assert.equal(repo.jest('test/nothing-here').status, 1)
		assert.equal(repo.jest('test/nothing-here', '--passWithNoTests').status, 0)
	})
})

describe('shards', () => {
	let repo: Repo
	before(() => {
		repo = new Repo('basic')
	})
	after(() => repo.cleanup())

	/** What each of the two shards ran when everything ran. */
	const owned: string[][] = []

	test("the shards are Jest's own: between them they run every test file once, and each keeps a record", () => {
		for (const shard of [1, 2]) {
			const result = repo.jest('--shard', `${shard}/2`, '--passWithNoTests')
			assert.equal(result.status, 0, result.output)
			owned.push(Repo.ran(result))
			assert.deepEqual(
				Object.keys(repo.records(`.${shard}of2`).files).sort(),
				Repo.ran(result).map((name) => `test/${name}.test.js`),
			)
		}
		assert.deepEqual(owned.flat().sort(), ALL)
	})

	test('a change reruns its test files on the shard that ran them, and nothing on the other', () => {
		repo.append('src/a.js', '// edit\n')
		const ran = [1, 2].map((shard) =>
			Repo.ran(repo.jest('--shard', `${shard}/2`, '--passWithNoTests')),
		)
		assert.ok(ran.flat().length > 0)
		assert.equal(new Set(ran.flat()).size, ran.flat().length)
		for (const [at, names] of ran.entries()) {
			for (const name of names) assert.ok(owned[at]?.includes(name), name)
		}
	})
})

describe('a test that starts a Jest of its own', () => {
	let repo: Repo
	before(() => {
		repo = new Repo('nested')
	})
	after(() => repo.cleanup())

	test('the inner run leaves the record of the outer one alone', () => {
		const first = repo.jest('--runInBand')
		assert.equal(first.status, 0, first.output)
		assert.match(first.lines.join('\n'), /record: 2 of 2 test file\(s\) vouched for/)
		assert.deepEqual(Object.keys(repo.records().files).sort(), [
			'test/first.test.js',
			'test/nested.test.js',
		])
		assert.deepEqual(Repo.ran(repo.jest('--runInBand')), [])
	})

	test('a test file of the inner run is a dependency of the test file that started it', () => {
		repo.write('inner/inner.fixture.js', "test('inner', () => {\n\texpect(1).toBe(1)\n})\n")
		const changed = repo.jest('--runInBand')
		assert.equal(changed.status, 0, changed.output)
		assert.deepEqual(Repo.ran(changed), ['nested'])
		assert.deepEqual(Repo.ran(repo.jest('--runInBand')), [])
	})
})
