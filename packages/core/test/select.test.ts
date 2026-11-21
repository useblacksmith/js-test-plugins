import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
	emptyRecords,
	loadRecords,
	specKey,
	storeRecords,
	type FileRecord,
	type Records,
	type RunRecord,
} from '../src/record.ts'
import { compileRules, mergeRecords, select } from '../src/select.ts'

/** The rules every plugin selects and merges by, on records written out by hand. */

const passed = { state: 'passed' } as const

function records(files: Record<string, Partial<FileRecord>>, rest: Partial<Records> = {}): Records {
	return {
		...emptyRecords(),
		at: 1,
		...rest,
		files: Object.fromEntries(
			Object.entries(files).map(([spec, entry]) => [
				spec,
				{ deps: [], tests: { works: passed }, ...entry },
			]),
		),
	}
}

const reasons = (verdict: ReturnType<typeof select>): Record<string, string | null> =>
	Object.fromEntries(
		Object.entries(verdict).map(([spec, decision]) => [
			spec,
			decision.run ? decision.reason : null,
		]),
	)

test('a test file runs without a record, for a changed dependency, or after a failure', () => {
	const stored = records({
		'test/a.test.js': { deps: ['src/a.js'] },
		'test/b.test.js': { deps: ['src/b.js'] },
		'test/c.test.js': { tests: { works: { state: 'failed' } } },
		'test/d.test.js': { failed: true },
	})
	assert.deepEqual(
		reasons(
			select(
				stored,
				['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/new.test.js'],
				['src/a.js'],
			),
		),
		{
			'test/a.test.js': 'changed: src/a.js',
			'test/b.test.js': null,
			'test/c.test.js': 'failed last time',
			'test/d.test.js': 'failed last time',
			'test/new.test.js': 'no record',
		},
	)
})

test('a change to the test file itself, to what every test file depends on, or to what its project depends on runs it', () => {
	const stored = records(
		{
			'test/a.test.js': {},
			[specKey('test/b.test.js', 'node')]: {},
			[specKey('test/b.test.js', 'browser')]: {},
		},
		{ global: ['setup.js'], projects: { node: ['node.config.js'] } },
	)
	const specs = Object.keys(stored.files)
	assert.deepEqual(reasons(select(stored, specs, ['test/a.test.js'])), {
		'test/a.test.js': 'changed: test/a.test.js',
		[specKey('test/b.test.js', 'node')]: null,
		[specKey('test/b.test.js', 'browser')]: null,
	})
	assert.deepEqual(Object.values(reasons(select(stored, specs, ['setup.js']))), [
		'changed: setup.js',
		'changed: setup.js',
		'changed: setup.js',
	])
	assert.deepEqual(reasons(select(stored, specs, ['node.config.js'])), {
		'test/a.test.js': null,
		[specKey('test/b.test.js', 'node')]: 'changed: node.config.js',
		[specKey('test/b.test.js', 'browser')]: null,
	})
})

test('dependencies are closed over the import graph, and a test reruns alone for what only it read', () => {
	const stored = records(
		{
			'test/a.test.js': {
				all: ['one', 'two', 'three'],
				tests: {
					one: { state: 'passed', deps: ['data/one.json'] },
					two: { state: 'passed', deps: ['src/lazy.js'] },
				},
			},
		},
		{ graph: { 'test/a.test.js': ['src/a.js'], 'src/a.js': ['src/deep.js'], 'src/lazy.js': ['src/lazier.js'] } },
	)
	assert.deepEqual(select(stored, ['test/a.test.js'], ['src/deep.js'])['test/a.test.js'], {
		run: true,
		reason: 'changed: src/deep.js',
		stale: true,
	})
	assert.deepEqual(select(stored, ['test/a.test.js'], ['src/lazier.js'])['test/a.test.js'], {
		run: true,
		reason: 'changed: src/lazier.js',
		tests: [
			{ title: 'two', reason: 'changed: src/lazier.js', stale: true },
			{ title: 'three', reason: 'never ran' },
		],
	})
})

test('a manifest above a test file or above what it loaded runs it', () => {
	const stored = records({
		'packages/a/test/a.test.js': { deps: ['packages/a/src/a.js'] },
		'packages/b/test/b.test.js': { deps: ['packages/b/src/b.js', 'packages/a/src/a.js'] },
		'packages/c/test/c.test.js': { deps: ['packages/c/src/c.js'] },
	})
	const specs = Object.keys(stored.files)
	assert.deepEqual(reasons(select(stored, specs, ['packages/a/package.json'])), {
		'packages/a/test/a.test.js': 'changed: packages/a/package.json',
		'packages/b/test/b.test.js': 'changed: packages/a/package.json',
		'packages/c/test/c.test.js': null,
	})
	assert.deepEqual(
		Object.values(reasons(select(stored, specs, ['tsconfig.base.json']))),
		Array.from({ length: 3 }, () => 'changed: tsconfig.base.json'),
	)
})

test('a manifest above a file reached only through the import graph runs the test file', () => {
	const stored = records(
		{ 'test/a.test.js': {}, 'test/b.test.js': {} },
		{ graph: { 'test/a.test.js': ['src/a.js'], 'src/a.js': ['lib/deep/x.js'] } },
	)
	const specs = Object.keys(stored.files)
	assert.deepEqual(reasons(select(stored, specs, ['lib/deep/package.json'])), {
		'test/a.test.js': 'changed: lib/deep/package.json',
		'test/b.test.js': null,
	})
})

test('a manifest above what one test read runs that test alone', () => {
	const stored = records({
		'test/a.test.js': {
			tests: {
				reads: { state: 'passed', deps: ['data/c.txt'] },
				other: { state: 'passed', deps: ['src/a.js'] },
			},
		},
	})
	assert.deepEqual(select(stored, ['test/a.test.js'], ['data/tsconfig.json'])['test/a.test.js'], {
		run: true,
		reason: 'changed: data/tsconfig.json',
		tests: [{ title: 'reads', reason: 'changed: data/tsconfig.json', stale: true }],
	})
})

test('a lockfile runs the test files whose packages are not all known', () => {
	const stored = records({
		'test/a.test.js': { deps: ['node_modules/known'] },
		'test/b.test.js': { incomplete: true },
	})
	assert.deepEqual(reasons(select(stored, Object.keys(stored.files), ['pnpm-lock.yaml'])), {
		'test/a.test.js': null,
		'test/b.test.js': 'changed: pnpm-lock.yaml',
	})
})

test('rules map files nothing reads to the test files that depend on them', () => {
	const stored = records({
		'packages/a/test/db/a.test.js': {},
		'packages/a/test/b.test.js': { tests: { works: { state: 'passed', endpoints: ['127.0.0.1:5432'] } } },
		'packages/a/test/c.test.js': { endpoints: ['127.0.0.1:6379'] },
	})
	const rules = compileRules(
		{
			dependencies: { 'test/db/**': ['migrations/**', '../shared/schema.sql'] },
			services: { '127.0.0.1:5432': 'docker/postgres/**' },
		},
		'packages/a',
	)
	const specs = Object.keys(stored.files)
	const run = (changed: string): (string | null)[] =>
		Object.values(reasons(select(stored, specs, [changed], { rules })))
	assert.deepEqual(run('packages/a/migrations/1.sql'), ['changed: packages/a/migrations/1.sql', null, null])
	assert.deepEqual(run('packages/shared/schema.sql'), ['changed: packages/shared/schema.sql', null, null])
	assert.deepEqual(run('migrations/1.sql'), [null, null, null])
	assert.deepEqual(run('packages/a/docker/postgres/init.sql'), [
		null,
		'changed: packages/a/docker/postgres/init.sql',
		null,
	])
	assert.deepEqual(rules.dependencies[0]?.bases, ['packages/a/migrations', 'packages/shared/schema.sql'])
	assert.ok(rules.names('packages/a/docker/postgres/init.sql'))
	assert.ok(!rules.names('packages/a/src/a.js'))
})

test('narrowing spares a test file a change inside a file it loaded cannot reach, never one to the test file', () => {
	const stored = records({ 'test/a.test.js': { deps: ['src/a.js'] } })
	const affects = (): boolean => false
	assert.deepEqual(reasons(select(stored, ['test/a.test.js'], ['src/a.js'], { affects })), {
		'test/a.test.js': null,
	})
	assert.deepEqual(reasons(select(stored, ['test/a.test.js'], ['test/a.test.js'], { affects })), {
		'test/a.test.js': 'changed: test/a.test.js',
	})
})

const run = (files: RunRecord['files'], rest: Partial<RunRecord> = {}): RunRecord => ({
	at: 2,
	global: [],
	files,
	...rest,
})

test('a merge drops what the change staled, even for a test file the run left out', () => {
	const stored = records({
		'test/a.test.js': { deps: ['src/a.js'] },
		'test/b.test.js': { deps: ['src/b.js'] },
	})
	const merged = mergeRecords(stored, [run({})], ['src/a.js'])
	assert.deepEqual(Object.keys(merged.files), ['test/b.test.js'])
})

test('a test file that ran in full replaces its record', () => {
	const stored = records({ 'test/a.test.js': { deps: ['src/old.js'], failed: true } })
	const merged = mergeRecords(
		stored,
		[run({ 'test/a.test.js': { deps: ['src/new.js'], tests: { works: passed } } })],
		[],
	)
	assert.deepEqual(merged.files['test/a.test.js'], {
		deps: ['src/new.js'],
		tests: { works: passed },
		at: 2,
	})
	assert.equal(merged.at, 2)
})

test('a test file that ran in part adds to its record, and is not vouched for without one', () => {
	const part = { deps: ['src/b.js'], tests: { two: passed }, partial: true }
	const stored = records({ 'test/a.test.js': { deps: ['src/a.js'], tests: { one: passed, two: { state: 'failed' } } } })
	assert.deepEqual(mergeRecords(stored, [run({ 'test/a.test.js': part })], []).files['test/a.test.js'], {
		deps: ['src/a.js', 'src/b.js'],
		tests: { one: passed, two: passed },
		at: 2,
	})
	assert.equal(
		mergeRecords(null, [run({ 'test/a.test.js': part })], []).files['test/a.test.js']?.failed,
		true,
	)
})

test('a runner that names every test keeps the ones a run left out, unless a hook failed', () => {
	const stored = records({
		'test/a.test.js': { all: ['one', 'two'], tests: { one: passed, two: passed } },
	})
	const grep = { deps: [], all: ['one', 'two'], tests: { one: { state: 'failed' as const } } }
	const merged = mergeRecords(stored, [run({ 'test/a.test.js': grep })], [])
	assert.deepEqual(merged.files['test/a.test.js']?.tests, { one: { state: 'failed' }, two: passed })
	assert.equal(merged.files['test/a.test.js']?.failed, undefined)
	const hook = mergeRecords(stored, [run({ 'test/a.test.js': { ...grep, tests: {}, failed: true } })], [])
	assert.deepEqual(hook.files['test/a.test.js']?.tests, {})
	assert.equal(hook.files['test/a.test.js']?.failed, true)
	// A first run that leaves a test out: the file stays affected, for that test.
	const first = mergeRecords(null, [run({ 'test/a.test.js': { ...grep, tests: { one: passed } } })], [])
	assert.deepEqual(select(first, ['test/a.test.js'], [])['test/a.test.js'], {
		run: true,
		reason: 'never ran',
		tests: [{ title: 'two', reason: 'never ran' }],
	})
})

test('what every test file depends on is replaced by a run of them all and added to by a run of some', () => {
	const stored = records(
		{ 'test/a.test.js': {}, 'test/b.test.js': {} },
		{ global: ['old-setup.js', 'node_modules/transformer'] },
	)
	const file = { deps: [], tests: { works: passed } }
	const some = mergeRecords(stored, [run({ 'test/a.test.js': file }, { global: ['setup.js'] })], [])
	assert.deepEqual(some.global, ['node_modules/transformer', 'old-setup.js', 'setup.js'])
	const all = mergeRecords(
		stored,
		[run({ 'test/a.test.js': file, 'test/b.test.js': file }, { global: ['setup.js'] })],
		[],
	)
	assert.deepEqual(all.global, ['node_modules/transformer', 'setup.js'])
})

test('the graph is unioned across runs, without the edges out of a changed file', () => {
	const stored = records({ 'test/a.test.js': {} }, { graph: { 'src/a.js': ['src/b.js'], 'src/c.js': ['src/d.js'] } })
	const merged = mergeRecords(
		stored,
		[run({}, { graph: { 'src/a.js': ['src/e.js'], 'src/c.js': ['src/f.js'] } })],
		['src/c.js'],
	)
	assert.deepEqual(merged.graph, { 'src/a.js': ['src/b.js', 'src/e.js'], 'src/c.js': ['src/f.js'] })
})

test('the record is stored with each path once and read back as it was', () => {
	const stored = records(
		{
			[specKey('test/a.test.js', 'node')]: {
				deps: ['src/a.js', 'package.json'],
				manifests: ['package.json'],
				endpoints: ['127.0.0.1:1'],
				all: ['one', 'two'],
				tests: { one: passed, two: { state: 'skipped', deps: ['src/a.js'], endpoints: ['127.0.0.1:2'] } },
				at: 5,
			},
		},
		{ global: ['setup.js'], projects: { node: ['src/a.js'] }, graph: { 'src/a.js': ['setup.js'] } },
	)
	const file = storeRecords(stored)
	assert.equal(file.paths.length, new Set(file.paths).size)
	assert.deepEqual(loadRecords(JSON.parse(JSON.stringify(file))), stored)
	assert.equal(loadRecords({ ...file, version: 6 }), null)
})
