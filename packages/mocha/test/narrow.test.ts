import assert from 'node:assert/strict'
import { after, beforeEach, describe, test } from 'node:test'

import { Repo } from './harness.ts'

const SPECS = ['add', 'lazy1', 'lazy2', 'legacy', 'pair', 'sub', 'table']
const GLOB = 'test/*.test.js'

/** `file` with the first `from` replaced: a change to one function's body. */
function edit(repo: Repo, file: string, from: string, to: string): void {
	const before = repo.read(file)
	assert.ok(before.includes(from), `${file} has no ${from}`)
	repo.write(file, before.replace(from, to))
}

describe('narrowing inside a changed module', () => {
	let repo: Repo
	const first = () => {
		const result = repo.cli('run', '--', GLOB)
		assert.equal(result.status, 0, result.output)
		assert.deepEqual(Repo.ran(result), SPECS)
	}
	beforeEach(() => {
		repo = new Repo('narrowing')
	})
	after(() => repo.cleanup())

	const run = () => {
		const result = repo.cli('run', '--', GLOB)
		assert.equal(result.status, 0, result.output)
		return Repo.ran(result)
	}

	test('a changed function reruns only the spec files whose tests entered it', () => {
		first()
		edit(repo, 'src/math.js', 'return a - b', 'return a - b + 0')
		assert.deepEqual(run(), ['sub'])
		assert.deepEqual(run(), [])
		edit(repo, 'src/math.js', 'return a + b', 'return a + b + 0')
		assert.deepEqual(run(), ['add'])
	})

	test('a function the module calls as it loads reruns every spec file that loaded the module', () => {
		first()
		edit(repo, 'src/math.js', 'return [1, 2, 3]', 'return [3, 2, 1]')
		assert.deepEqual(run(), ['add', 'sub', 'table'])
	})

	test('a module first loaded inside a test: what its load entered counts for the spec files that import it later', () => {
		first()
		edit(repo, 'src/lazy.js', "return 'ready'", "return 'ready' + ''")
		assert.deepEqual(run(), ['lazy1', 'lazy2'])
	})

	test('a function no test entered reruns nothing', () => {
		first()
		edit(repo, 'src/lazy.js', "return 'late'", "return 'later'")
		assert.deepEqual(run(), [])
	})

	test('a CommonJS module is not narrowed: any change to it reruns what loaded it', () => {
		first()
		edit(repo, 'src/legacy.cjs', "return 'unused'", "return 'still unused'")
		assert.deepEqual(run(), ['legacy'])
	})

	test('after a run of some of a file\'s tests, a change to what the others entered still reruns the file', () => {
		first()
		edit(repo, 'src/pair.js', 'return 1', 'return 1 + 0')
		const some = repo.cli('run', '--', GLOB, '--grep', 'calls one')
		assert.equal(some.status, 0, some.output)
		assert.deepEqual(Repo.ran(some), ['pair'])
		edit(repo, 'src/pair.js', 'return 2', 'return 2 + 0')
		assert.deepEqual(run(), ['pair'])
	})

	test('BLACKSMITH_MOCHA_NARROW=0 and coverage rerun every spec file that loaded the changed module', () => {
		for (const [name, value] of [
			['BLACKSMITH_MOCHA_NARROW', '0'],
			['NYC_CONFIG', '{}'],
		] as const) {
			repo = new Repo('narrowing')
			repo.env[name] = value
			first()
			edit(repo, 'src/math.js', 'return a - b', 'return a - b + 0')
			assert.deepEqual(run(), ['add', 'sub', 'table'], name)
		}
	})

	test('--parallel records what each worker entered', () => {
		const result = repo.cli('run', '--', GLOB, '--parallel')
		assert.equal(result.status, 0, result.output)
		edit(repo, 'src/math.js', 'return a - b', 'return a - b + 0')
		assert.deepEqual(Repo.ran(repo.cli('run', '--', GLOB, '--parallel')), ['sub'])
	})
})
