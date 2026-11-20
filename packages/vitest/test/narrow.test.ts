import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { difference, resolveDigest } from '../../shared/src/narrow.ts'
import { analyze, footer } from '../../shared/src/units.ts'
import { packageRoot } from './harness.ts'

const vitestBin = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs')
const ALL = [
	'arrow',
	'box',
	'called',
	'derived',
	'dynamic',
	'limit',
	'namespace',
	'reads',
	'renamed',
]
const repos: string[] = []

afterAll(() => {
	for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

/** A copy of the fixture in its own git repository, with one full run recorded. */
class Repo {
	readonly dir: string
	private runs = 0

	constructor(name: string) {
		this.dir = path.join(packageRoot, 'test', `fixture-runs-narrow-${name}-${process.pid}`)
		rmSync(this.dir, { recursive: true, force: true })
		cpSync(path.join(packageRoot, 'test', 'fixture-narrow'), this.dir, { recursive: true })
		this.git('init', '-q', '-b', 'main')
		this.git('config', 'user.email', 'ci@example.com')
		this.git('config', 'user.name', 'ci')
		this.commit()
		repos.push(this.dir)
	}

	git(...args: string[]): string {
		return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8' })
	}

	commit(): void {
		this.git('add', '-A')
		this.git('commit', '-q', '--allow-empty', '-m', 'change')
	}

	edit(file: string, from: string, to: string): void {
		const target = path.join(this.dir, file)
		const before = readFileSync(target, 'utf8')
		if (!before.includes(from)) throw new Error(`${file} has no ${from}`)
		writeFileSync(target, before.replace(from, to))
	}

	/** Basenames of the test files that ran, sorted. */
	run(...args: string[]): Promise<string[]> {
		const results = path.join(this.dir, `results-${this.runs++}.json`)
		return new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[vitestBin, 'run', '--reporter=json', `--outputFile=${results}`, ...args],
				{
					cwd: this.dir,
					env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CI: 'true' },
				},
			)
			let output = ''
			child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
			child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
			child.on('error', reject)
			child.on('close', (exitCode) => {
				if (exitCode !== 0) return reject(new Error(output))
				const ran = existsSync(results)
					? (
							JSON.parse(readFileSync(results, 'utf8')) as {
								testResults: { name: string }[]
							}
						).testResults.map((result) => path.basename(result.name, '.test.ts'))
					: []
				rmSync(results, { force: true })
				this.commit()
				resolve(ran.sort())
			})
		})
	}
}

async function recorded(name: string): Promise<Repo> {
	const repo = new Repo(name)
	expect(await repo.run()).toEqual(ALL)
	expect(await repo.run()).toEqual([])
	return repo
}

describe('narrow: which test files a change inside a file reruns', () => {
	test('a function body reruns the test files that called it', async () => {
		const repo = await recorded('body')
		repo.edit('src/lib.ts', 'helper(n) + 1', 'helper(n) + 1 + 0')
		expect(await repo.run()).toEqual(['called'])
		repo.edit('src/lib.ts', 'n * 2', 'n * 2 + 0')
		expect(await repo.run()).toEqual(['arrow'])
		// Through the barrel's renamed re-export too.
		repo.edit('src/helper.ts', 'return n', 'return n + 0')
		expect(await repo.run()).toEqual(['called', 'renamed'])
		repo.edit('src/helper.ts', 'return 0', 'return 1')
		expect(await repo.run()).toEqual([])
	})

	test('a value reruns the test files that loaded a module importing it', async () => {
		const repo = await recorded('value')
		// `DERIVED` is built from it, `reads()` returns it, and a namespace
		// import may read anything.
		repo.edit('src/lib.ts', 'LIMIT = 5', 'LIMIT = 6')
		expect(await repo.run()).toEqual(['derived', 'limit', 'namespace', 'reads'])
		repo.edit('src/lib.ts', "'unused'", "'still unused'")
		expect(await repo.run()).toEqual(['namespace'])
		repo.edit('src/lib.ts', 'return 1', 'return 2 - 1')
		expect(await repo.run()).toEqual(['box', 'namespace'])
	})

	test('types, comments and new declarations rerun nothing', async () => {
		const repo = await recorded('types')
		repo.edit('src/lib.ts', 'size: number', 'size: bigint // wider')
		repo.edit('src/lib.ts', '(n: number): number => n * 2', '(n: number) => n * 2')
		expect(await repo.run()).toEqual([])
		repo.edit('src/helper.ts', 'export function spare', 'function added() {}\nexport function spare')
		expect(await repo.run()).toEqual([])
	})

	test('anything else at the top level reruns every test file that loaded the file', async () => {
		const repo = await recorded('rest')
		repo.edit('src/lib.ts', 'export const LIMIT', "console.log('loading')\nexport const LIMIT")
		expect(await repo.run()).toEqual(ALL.filter((name) => name !== 'dynamic'))
		repo.edit('src/lib.ts', "console.log('loading')\n", '')
		expect(await repo.run()).toEqual(ALL.filter((name) => name !== 'dynamic'))
	})

	test('a change made, undone and made again reruns each time', async () => {
		const repo = await recorded('again')
		for (const [from, to] of [
			['helper(n) + 1', 'helper(n) + 1 + 0'],
			['helper(n) + 1 + 0', 'helper(n) + 1'],
			['helper(n) + 1', 'helper(n) + 1 + 0'],
		] as const) {
			repo.edit('src/lib.ts', from, to)
			expect(await repo.run()).toEqual(['called'])
		}
	})

	test('a run of some test files leaves the change pending for the others', async () => {
		const repo = await recorded('filtered')
		repo.edit('src/helper.ts', 'return n', 'return n + 0')
		await repo.run('src/arrow.test.ts')
		expect(await repo.run()).toEqual(['called', 'renamed'])
	})

	test('a parameter list counts as a value: it runs even when the body is never entered', async () => {
		const repo = await recorded('signature')
		repo.edit('src/helper.ts', 'spare()', 'spare(n = 1)')
		expect(await repo.run()).toEqual([])
		repo.edit('src/lib.ts', 'reads()', 'reads(n = LIMIT)')
		expect(await repo.run()).toEqual(['namespace', 'reads'])
	})

	test('a new import reruns the test files that had not loaded its target', async () => {
		const repo = await recorded('import')
		repo.edit('src/lazy.ts', 'OTHER = 2', "OTHER = 2\nimport { helper } from './helper.ts'\nexport const SUM = helper(1)")
		// `dynamic` never loaded helper.ts; a dynamic import may read any name.
		expect(await repo.run()).toEqual(['dynamic'])
		repo.edit('src/lib.ts', "import { helper } from './helper.ts'", "import { helper, spare } from './helper.ts'\nexport const SPARE = spare")
		expect(await repo.run()).toEqual(['namespace'])
	})

	test('a file loaded by a dynamic import reruns on any value in it', async () => {
		const repo = await recorded('dynamic')
		repo.edit('src/lazy.ts', 'OTHER = 2', 'OTHER = 3')
		expect(await repo.run()).toEqual(['dynamic'])
	})

	test('a test file run in part keeps what its other tests entered', async () => {
		const repo = await recorded('partial')
		repo.edit('src/called.test.ts', "test('called'", "test('nothing', () => {})\ntest('called'")
		expect(await repo.run()).toEqual(['called'])
		expect(await repo.run('-t', 'nothing')).toEqual([])
		repo.edit('src/lib.ts', 'helper(n) + 1', 'helper(n) + 1 + 0')
		expect(await repo.run()).toEqual(['called'])
		// A filtered run after an edit does not stand in for the tests it left out.
		repo.edit('src/lib.ts', 'n * 2', 'n * 2 + 0')
		await repo.run('-t', 'nothing')
		expect(await repo.run()).toEqual(['arrow'])
	})
})

describe('narrow: module digests', () => {
	const digest = (code: string, file = 'a.ts') => {
		const analysis = analyze(code, file)
		if (!analysis) throw new Error('not analysable')
		return resolveDigest(analysis.digest, {})
	}

	test('files that cannot be taken apart', () => {
		expect(analyze('module.exports = { a: 1 }', 'a.js')).toBeNull()
		expect(analyze('export const a = eval("1")', 'a.js')).toBeNull()
		expect(analyze('export const a = ', 'a.ts')).toBeNull()
		expect(analyze('{"a": 1}', 'a.json')).toBeNull()
		expect(analyze('export declare const a: number', 'a.d.ts')).toBeNull()
	})

	test('instrumented code keeps directives first and runs as before', async () => {
		const code = [
			"'use client'",
			'export function strict(a) { "use strict"; return a }',
			'export const short = (a) => ({ a })',
			'export async function* later(a) { yield a }',
			'export default (a) => a',
		].join('\n')
		const analysis = analyze(code, 'a.js')
		if (!analysis) throw new Error('not analysable')
		let out = code
		for (const [at, text] of [...analysis.marks].sort((a, b) => b[0] - a[0])) {
			out = out.slice(0, at) + text + out.slice(at)
		}
		out += footer('a.js')
		expect(out.startsWith("'use client'\nexport function strict(a) { \"use strict\";;__")).toBe(true)
		const module = (await import(
			`data:text/javascript,${encodeURIComponent(out)}`
		)) as Record<string, (a: number) => unknown>
		const hits = (globalThis as unknown as Record<string, Record<string, object>>)
			.__BLACKSMITH_UNITS__?.['a.js']
		expect(Object.keys(hits ?? {})).toEqual([''])
		expect(module['short']?.(1)).toEqual({ a: 1 })
		expect(module['default']?.(2)).toBe(2)
		module['later']?.(3)
		expect(Object.keys(hits ?? {}).sort()).toEqual(['', 'default', 'short'])
	})

	test('a name that starts shadowing a global changes what mentions it', () => {
		const before = digest('export function f() { return fetch }')
		const after = digest('const fetch = 1\nexport function f() { return fetch }')
		expect(difference(before, after)).toMatchObject({ functions: new Set(['f']) })
	})

	test('an import TypeScript drops is not a module the file loads', () => {
		const before = digest("export const a = 1")
		const after = digest("import { T } from './types.ts'\nexport const a: T = 1")
		expect(difference(before, after)).toBeNull()
		expect(digest("import { T } from './types.js'\nexport const a = 1", 'a.js').sources).toEqual([
			'?./types.js',
		])
	})

	test('imports that change places rerun everything', () => {
		const before = digest("import './a.js'\nexport { b } from './b.js'\nexport const c = 1", 'm.js')
		const after = digest("export { b } from './b.js'\nimport './a.js'\nexport const c = 1", 'm.js')
		expect(difference(before, after)).toBe('all')
	})

	test('lazy imports that change places are a change to their function', () => {
		const before = digest("export async function f() {\n\tawait import('./a.js')\n\tawait import('./b.js')\n}", 'm.js')
		const after = digest("export async function f() {\n\tawait import('./b.js')\n\tawait import('./a.js')\n}", 'm.js')
		expect(difference(before, after)).toMatchObject({ functions: new Set(['f']) })
	})

	test('a lazily loaded module the file starts loading itself reruns everything', () => {
		const lazy = "export async function f() {\n\tawait import('./a.js')\n\tawait import('./b.js')\n}"
		const before = digest(`import './a.js'\n${lazy}`, 'm.js')
		const after = digest(`import './b.js'\n${lazy}`, 'm.js')
		expect(difference(before, after)).toBe('all')
	})

	test('a re-export TypeScript drops is not a module the file loads', () => {
		const before = digest("export { type T } from './types.ts'\nexport const a = 1")
		expect(before.sources).toEqual([])
		expect(difference(digest('export const a = 1'), before)).toBeNull()
		const after = digest("export { type T } from './types.ts'\nimport './types.ts'\nexport const a = 1")
		expect(difference(before, after)).toMatchObject({ added: ['?./types.ts'] })
	})

	test('a function held in a const that changes places reruns everything', () => {
		const before = digest('export const f = () => 1\nexport const a = f()')
		const after = digest('export const a = f()\nexport const f = () => 1')
		expect(difference(before, after)).toBe('all')
	})

	test('a directive without a semicolon stays apart from the inserted call', () => {
		const code = "export function f() {\n\t'use strict'\n\treturn 1\n}"
		const analysis = analyze(code, 'a.js')
		expect(analysis?.marks.map(([, text]) => text[0])).toEqual([';'])
	})

	test("a marked function's text runs outside its module", () => {
		const code = 'export function f() {\n\treturn 1\n}\nexport const g = () => 2'
		let marked = code
		for (const [at, text] of [...(analyze(code, 'a.js')?.marks ?? [])].sort((a, b) => b[0] - a[0])) {
			marked = marked.slice(0, at) + text + marked.slice(at)
		}
		const body = marked.replace(/export /g, '')
		expect(new Function(`${body}\nreturn [f(), g()]`)()).toEqual([1, 2])
	})

	test('a declaration named like an inherited property', () => {
		const names = Object.keys(
			digest('export const toString = 1\nexport function constructor() {}').units,
		)
		expect(names.sort()).toEqual(['constructor', 'toString'])
	})

	test('values that change places rerun everything', () => {
		const before = digest('export const a = 1\nexport const b = 2')
		const after = digest('export const b = 2\nexport const a = 1')
		expect(difference(before, after)).toBe('all')
	})
})
