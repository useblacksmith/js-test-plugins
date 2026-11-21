import assert from 'node:assert/strict'
import { after, beforeEach, describe, test } from 'node:test'

import { mark } from '../src/narrow.ts'
import { Repo } from './harness.ts'

const SPECS = ['add', 'chain', 'lazy1', 'lazy2', 'legacy', 'pair', 'sub', 'table', 'text']
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
		assert.deepEqual(Repo.ran(some), ['pair', 'text'])
		edit(repo, 'src/pair.js', 'return 2', 'return 2 + 0')
		assert.deepEqual(run(), ['pair', 'text'])
	})

	test('a test that reads a module as text reruns on any change to it', () => {
		first()
		edit(repo, 'src/pair.js', 'return 2', 'return 2 + 0')
		assert.deepEqual(run(), ['pair', 'text'])
	})

	test('a change that reruns nothing keeps what the changed module imports', () => {
		first()
		edit(repo, 'src/chain.js', "return 'unused'", "return 'still unused'")
		assert.deepEqual(run(), [])
		edit(repo, 'src/leaf.js', "return 'leaf'", "return 'leaf' + ''")
		assert.deepEqual(run(), ['chain'])
	})

	test('turned off after a run that narrowed, a change reruns every spec file that loaded the module', () => {
		first()
		repo.env.BLACKSMITH_MOCHA_NARROW = '0'
		edit(repo, 'src/math.js', 'return a - b', 'return a - b + 0')
		assert.deepEqual(Repo.ran(repo.cli('affected', '--', GLOB)), ['add', 'sub', 'table'])
		assert.deepEqual(run(), ['add', 'sub', 'table'])
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

describe('marks', () => {
	test('directives stay the first statements', () => {
		const marked = mark("'use strict'\nexport function f() {\n\treturn 1\n}\n", '/repo/a.js', 'a.js')
		assert.ok(marked?.startsWith("'use strict';globalThis."), marked ?? 'not marked')
	})

	test('a `#!` line stays the first', () => {
		const marked = mark('#!/usr/bin/env node\nexport function f() {\n\treturn 1\n}\n', '/repo/a.js', 'a.js')
		assert.ok(marked?.startsWith('#!/usr/bin/env node\nglobalThis.'), marked ?? 'not marked')
	})

	test('TypeScript reaches the global object through a variable a strict check accepts', () => {
		const marked = mark('export function f(): number {\n\treturn 1\n}\n', '/repo/a.ts', 'a.ts')
		assert.ok(marked && !marked.includes('globalThis'), marked ?? 'not marked')
	})

	test('line numbers stay as they were', () => {
		const code = "'use strict'\nexport function f() {\n\treturn 1\n}\n"
		const marked = mark(code, '/repo/a.js', 'a.js') ?? ''
		assert.equal(marked.split('\n')[2], code.split('\n')[2])
	})
})
