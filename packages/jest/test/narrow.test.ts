import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

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

		test('a run without the option forgets what the test files entered', () => {
			repo.env = { NARROW: '0' }
			edit('src/math.js', 'return a + b', 'return b + a')
			assert.deepEqual(run(), ALL)
			repo.env = {}
			edit('src/math.js', 'return b + a', 'return a + b')
			assert.deepEqual(run(), ALL)
			edit('src/math.js', 'return a + b', 'return b + a')
			assert.deepEqual(run(), ['add'])
		})
	})
}
