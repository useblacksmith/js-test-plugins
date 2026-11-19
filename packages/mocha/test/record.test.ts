import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { Repo, dependenciesOf } from './harness.ts'

/** Checks every spec's recorded dependency set against the fixture's `expected.json`. */
function matchesExpected(repo: Repo, args: string[]): void {
	const expected = JSON.parse(repo.read('expected.json')) as Record<
		string,
		string[]
	>
	const { result, run } = repo.record(...args, 'test/*.test.*')
	assert.equal(result.status, 0, result.output)
	for (const [spec, files] of Object.entries(expected)) {
		assert.deepEqual(dependenciesOf(run, spec), [...files].sort(), spec)
	}
}

for (const [mode, args] of [
	['serial', []],
	['--parallel', ['--parallel', '--jobs', '2']],
] as const) {
	describe(`imports, ${mode}`, () => {
		let repo: Repo
		before(() => {
			repo = new Repo('imports')
		})
		after(() => repo.cleanup())

		// CommonJS and ES modules that share dependencies, a `require()` and an
		// `import()` inside tests, ESM importing CommonJS and the reverse: every
		// spec after the first finds its dependencies already in the module cache.
		test('each spec file gets its own import closure when modules are already cached', () => {
			matchesExpected(repo, [...args])
		})
	})

	describe(`reads, child processes and worker threads, ${mode}`, () => {
		let repo: Repo
		before(() => {
			repo = new Repo('attribution')
		})
		after(() => repo.cleanup())

		// Reads at module load, in a hook, in tests and after a test ended; a
		// config read once and kept; node children and a worker thread.
		test('each is charged to the spec file that caused it', () => {
			matchesExpected(repo, [...args])
		})

		test('a read is recorded per test, and one a module keeps is charged to the module', () => {
			const { run } = repo.record(...args, 'test/*.test.*')
			assert.deepEqual(
				run.files['test/a.test.js']?.tests['a reads a.json']?.deps,
				['data/a.json'],
			)
			assert.ok(run.graph['src/config.js']?.includes('data/config.json'))
			assert.ok(run.graph['src/loadtime.js']?.includes('data/loadtime.json'))
		})
	})
}
