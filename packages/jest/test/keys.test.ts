import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { Repo } from './harness.ts'

// Every test file loads `src/flags.js` and a CommonJS module through the setup file.
// `alpha`, `beta` and `local` read one key of `FLAGS`, `any` a key it is given, `names` a
// value built from all of them; `idle` loads what `any` calls and does not call it.
describe('narrow: a change to one key of an object literal', () => {
	let repo: Repo
	const run = (): string[] => {
		const result = repo.jest('--runInBand')
		assert.equal(result.status, 0, result.output)
		return Repo.ran(result)
	}
	const edit = (from: string, to: string): void => {
		const text = repo.read('src/flags.js')
		assert.ok(text.includes(from), `no ${from}`)
		repo.write('src/flags.js', text.replace(from, to))
	}
	before(() => {
		repo = new Repo('keys')
	})
	after(() => repo.cleanup())

	test('the first run runs every test file, the next none', () => {
		assert.deepEqual(run(), ['alpha', 'any', 'beta', 'idle', 'local', 'names', 'plain'])
		assert.deepEqual(run(), [])
	})

	test('a changed key reruns what reads it and what uses the object whole', () => {
		edit("BETA: 'beta'", "BETA: 'beta-2'")
		assert.deepEqual(run(), ['any', 'beta', 'names'])
		edit("ALPHA: 'alpha'", "ALPHA: 'alpha' + ''")
		assert.deepEqual(run(), ['alpha', 'any', 'local', 'names'])
	})

	test('a new key and a removed one rerun only what uses the object whole', () => {
		edit("BETA: 'beta-2',", "BETA: 'beta-2',\n\tGAMMA: 'gamma',")
		assert.deepEqual(run(), ['any', 'names'])
		edit("\n\tGAMMA: 'gamma',", '')
		assert.deepEqual(run(), ['any', 'names'])
	})

	test('a comment on a key reruns nothing', () => {
		edit("BETA: 'beta-2',", "BETA: 'beta-2', // the second")
		assert.deepEqual(run(), [])
	})

	test('keys in another order rerun what imports the object', () => {
		edit("\tBETA: 'beta-2', // the second\n", '')
		edit('export const FLAGS = {\n', "export const FLAGS = {\n\tBETA: 'beta-2',\n")
		assert.deepEqual(run(), ['alpha', 'any', 'beta', 'idle', 'local', 'names'])
	})

	test('an object that is no longer plain keys reruns what imports it', () => {
		edit("\tBETA: 'beta-2',\n", "\t...{ BETA: 'beta-2' },\n")
		assert.deepEqual(run(), ['alpha', 'any', 'beta', 'idle', 'local', 'names'])
		edit("ALPHA: 'alpha' + ''", "ALPHA: 'alpha'")
		assert.deepEqual(run(), ['alpha', 'any', 'beta', 'idle', 'local', 'names'])
	})

	test('a changed value that only makes a value reruns what imports it', () => {
		edit('Object.keys(FLAGS)', 'Object.values(FLAGS)')
		assert.deepEqual(run(), ['names'])
	})

	test('a changed value that calls something reruns every test file that loaded the module', () => {
		edit('Object.values(FLAGS)', 'Object.keys(FLAGS).sort()')
		assert.deepEqual(run(), ['alpha', 'any', 'beta', 'idle', 'local', 'names', 'plain'])
	})
})
