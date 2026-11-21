import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { difference, Narrowing, resolveDigest } from '../../core/src/narrow.ts'
import { analyze, footer } from '../../core/src/units.ts'
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

	test('a CommonJS module is described by what it loads when asked', () => {
		const loads = (code: string) => analyze(code, 'a.js', undefined, true)?.digest
		expect(loads("const b = require('./b.js')\nmodule.exports = { ...b, c: require('./c.js').c }")).toMatchObject({
			opaque: true,
			wild: false,
			units: {},
			imports: [
				['./b.js', '*'],
				['./c.js', '*'],
			],
		})
		expect(loads('module.exports = {}')).toMatchObject({ opaque: true, wild: false, imports: [] })
		for (const code of [
			'module.exports = require(name)',
			'const load = require\nmodule.exports = load',
			"module.exports = require.resolve('./b.js')",
			'module.exports = eval("1")',
			"module.exports = module.require('./b.js')",
			"module.exports = module['require']('./b.js')",
			"module.exports = require('node:module').createRequire(__filename)('./b.js')",
		]) {
			expect(loads(code)).toMatchObject({ opaque: true, wild: true })
		}
		expect(loads('export const a = eval("1")')).toBeUndefined()
		const before = resolveDigest(loads("module.exports = require('./b.js')")!, {})
		const after = resolveDigest(loads("module.exports = require('./b.js') // same")!, {})
		expect(difference(before, after)).toBe('all')
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
		expect(out.startsWith("'use client'\nexport function strict(a) { \"use strict\";;typeof __")).toBe(true)
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

	test('a value that may do more than make it is told apart from one that cannot', () => {
		const made = (code: string) => digest(`export const a = ${code}`, 'a.tsx').units['a']?.effects
		for (const code of [
			'1',
			"'a' + `b${c}`",
			'[c, ...d]',
			'{ c, d: e.f, ...g }',
			'() => c()',
			'function () { return new C() }',
			'class { c = d(); e() { f() } }',
			'<C d={() => e()} />',
			'c as unknown as D<E>',
		]) {
			expect(made(code), code).toBeUndefined()
		}
		for (const code of [
			'c()',
			'new C()',
			'c`d`',
			'[c()]',
			'{ c: d() }',
			'(c = 1)',
			'c++',
			'delete c.d',
			"import('./c.ts')",
			'class { static c = d() }',
			'class { static { c() } }',
			'class { @c d() {} }',
			'class { @c d = 1 }',
			'class { d(@c e) {} }',
			'class { constructor(@c e) {} }',
			'class extends c() {}',
			'<C d={e()} />',
		]) {
			expect(made(code), code).toBe(true)
		}
		// A call of the language's that reads a `const` of literals runs nothing of the module's.
		const read = (code: string, before = '') =>
			digest(`const P = { b: 'c', d: ['e'], f: { g: 1 } } as const\nconst L = ['h', P.b]\n${before}\nexport const a = ${code}`)
				.units['a']?.effects
		for (const code of [
			'Object.keys(P)',
			'Object.values(P)',
			'Object.entries(P)',
			'Object.keys(L)',
			"Object.values({ b: 'c' })",
			'Object.keys(P as Record<string, () => void>)',
			'[Object.keys(P), Object.values(L)]',
			'Object.values({ ...P, h: [...L] })',
			"Object.values({ b: 'c' + `d${P.b}`, e: -1, f: P.b ? 1 : 2 })",
		]) {
			expect(read(code), code).toBeUndefined()
		}
		for (const code of [
			'Object.values(c)',
			'Object.values(P.f)',
			'Object.values(P.missing)',
			'Object.keys(null)',
			'Object.keys(undefined)',
			"Object.keys('b')",
			'Object.values(P, c)',
			'Object.values(...L)',
			'Object.values(P[c])',
			'Object.values({ ...c })',
			'Object.values({ get b() { return 1 } })',
			'Object.values({ b() {} })',
			'Object.values({ b: c })',
			'Object.values([c])',
			"Object.values({ b: 'c' + c })",
			'Object.values({ b: `${c}` })',
			'Object.values({ b: delete P.b })',
			'Object?.values(P)',
			'Object.values?.(P)',
			'Object[c](P)',
			'Object.assign(P)',
			'Object.freeze(P)',
			'Object.getOwnPropertyNames(P)',
			'Object.values(P).filter((b) => b)',
			'Object.keys(P).sort()',
			'Object.keys(P).length.toString()',
			'L.map((b) => b)',
			'L.join()',
			'String(P)',
			'JSON.stringify(P)',
			'new Set(L)',
			'Array.from(L)',
			'Reflect.ownKeys(P)',
			'c.Object.values(P)',
		]) {
			expect(read(code), code).toBe(true)
		}
		// Not of a `let`, of one made of more than literals, or once something else of the module's has run.
		for (const [before, code] of [
			["let M = { b: 'c' }", 'Object.values(M)'],
			["var M = { b: 'c' }", 'Object.values(M)'],
			['const M = { b: c }', 'Object.values(M)'],
			['const M = c({})', 'Object.values(M)'],
			['const { M } = { M: {} }', 'Object.values(M)'],
			['c(P)', 'Object.values(P)'],
			['c()', 'Object.values(L)'],
			['const M = c()', 'Object.values(P)'],
			['P.b = 1', 'Object.values(P)'],
			['class C { static d = c() }', 'Object.values(P)'],
			['@c class C {}', 'Object.values(P)'],
			['export default c()', 'Object.values(P)'],
			['export const d = c()', 'Object.values(P)'],
		] as const) {
			expect(read(code, before), `${before}; ${code}`).toBe(true)
		}
		// What only declares, or reads, leaves it as written.
		for (const before of ['function c(d: Object): Object { return d as Object }', 'type T = Record<string, Object>', "import type { Object } from './c.ts'", 'function c() { return Object.freeze({ Object: 1 }) }', 'function c() { P.b = 1 }', 'const M = () => c(P)', 'const M = P.d', 'type T = typeof P', 'export { P }']) {
			expect(read('Object.values(P)', before), before).toBeUndefined()
		}
		// A name of the module's own is not the language's.
		for (const code of [
			"import { Object } from './c.ts'\nconst P = {}\nexport const a = Object.values(P)",
			'const Object = c\nconst P = {}\nexport const a = Object.values(P)',
			'function Object() {}\nconst P = {}\nexport const a = Object.values(P)',
			'const P = {}\nexport const a = class Object { static b = Object.values(P) }',
			'const P = {}\nfunction c(Object) {}\nexport const a = Object.values(P)',
			'const P = {}\nenum Object { b }\nexport const a = Object.values(P)',
			'const P = {}\nnamespace Object { export const b = 1 }\nexport const a = Object.values(P)',
			'const P = {}\nfunction c() { Object.values = d }\nexport const a = Object.values(P)',
			'const P = {}\nfunction c() { delete Object.values }\nexport const a = Object.values(P)',
			'const P = {}\nfunction c() { d(Object) }\nexport const a = Object.values(P)',
			'const P = {}\nfunction c() { Object[d] = e }\nexport const a = Object.values(P)',
		]) {
			expect(digest(code).units['a']?.effects, code).toBe(true)
		}
		expect(digest('export function a() { b() }').units['a']?.effects).toBeUndefined()
		for (const code of ['export default c()', 'export default class { static c = d() }', 'export class a { static c = d() }']) {
			const units = Object.values(digest(code).units)
			expect(units.some((unit) => unit.effects), code).toBe(true)
		}
		expect(Object.values(digest('export default [1]').units).some((unit) => unit.effects)).toBe(false)
		expect(digest('export enum A { B = 1 }').units['A']?.effects).toBeUndefined()
	})

	test('a changed value that may do more than make it is a change for every test that loaded the module', () => {
		const logic = (code: string) => digest(`import { make } from './make.ts'\nexport const a = ${code}\nexport const b = 1`)
		expect(difference(logic("make('a')"), logic("make('b')"))).toBe('all')
		expect(difference(logic("'a'"), logic("make('a')"))).toBe('all')
		expect(difference(logic("make('a')"), logic("'a'"))).toBe('all')
		expect(difference(logic("['a']"), logic("['b']"))).toMatchObject({ values: new Set(['a']) })
		// One that is new or gone ran, or no longer runs, for each of them.
		const more = digest("import { make } from './make.ts'\nexport const a = 'a'\nexport const b = 1\nconst c = make('c')")
		expect(difference(logic("'a'"), more)).toBe('all')
		expect(difference(more, logic("'a'"))).toBe('all')
	})

	describe('an object literal of plain keys', () => {
		const flags = (body: string, tail = '') => digest(`export const FLAGS = {\n${body}\n} as const\n${tail}`)

		test('a changed, new or removed key is a change to that key', () => {
			const before = flags("A: 'a',\nB: 'b',")
			expect(difference(before, flags("A: 'a',\nB: 'b2',"))).toMatchObject({
				values: new Set(['FLAGS']),
				keys: new Map([['FLAGS', new Set(['B'])]]),
			})
			expect(difference(before, flags("A: 'a',\nB: 'b',\nC: 'c',"))).toMatchObject({
				keys: new Map([['FLAGS', new Set(['C'])]]),
			})
			expect(difference(before, flags("B: 'b',"))).toMatchObject({
				keys: new Map([['FLAGS', new Set(['A'])]]),
			})
		})

		test('space, comments and quotes between the keys change nothing', () => {
			const before = flags("A: 'a',\nB: 'b',")
			expect(difference(before, flags("A: 'a', // first\n\n  'B': 'b'"))).toBeNull()
		})

		test('keys in another order are a change to the whole value', () => {
			const change = difference(flags('A: a,\nB: b,'), flags('B: b,\nA: a,'))
			expect(change).toMatchObject({ values: new Set(['FLAGS']), keys: new Map() })
		})

		test('a function of the module reruns for the keys it reads', () => {
			const tail = 'export const a = () => FLAGS.A\nexport const any = (k) => FLAGS[k]\nexport const b = () => FLAGS.B'
			const change = difference(flags("A: 'a',\nB: 'b',", tail), flags("A: 'a',\nB: 'b2',", tail))
			expect(change).toMatchObject({ functions: new Set(['any', 'b']) })
		})

		test('a value built from the object, or a statement reading the key, takes the change', () => {
			const built = 'export const LIST = Object.values(FLAGS)'
			expect(
				difference(flags("A: 'a',", built), flags("A: 'a',\nB: 'b',", built)),
			).toMatchObject({ values: new Set(['FLAGS', 'LIST']), keys: new Map([['FLAGS', new Set(['B'])]]) })
			const read = 'console.log(FLAGS.A)'
			expect(difference(flags("A: 'a',\nB: 'b',", read), flags("A: 'a',\nB: 'b2',", read))).not.toBe('all')
			expect(difference(flags("A: 'a',\nB: 'b',", read), flags("A: 'a2',\nB: 'b',", read))).toBe('all')
		})

		test('more than a key is a change to the whole value', () => {
			const before = flags("A: 'a',")
			for (const after of [
				digest("export const FLAGS = {\nA: 'a',\n...more\n} as const"),
				digest("export const FLAGS = {\nA: 'a',\n[key]: 1\n} as const"),
				digest("export const FLAGS = {\nA: 'a',\nget B() { return 1 }\n} as const"),
				digest("export const FLAGS = {\nA: 'a',\nb() { return this.A }\n} as const"),
				digest("export const FLAGS = {\nA: 'a',\nb: function () { return this.A }\n} as const"),
				digest("export const FLAGS = {\nA: 'a',\ntoString: 1\n} as const"),
				digest("export let FLAGS = {\nA: 'a',\nB: 'b'\n}"),
			]) {
				const change = difference(before, after)
				expect(change).toMatchObject({ values: new Set(['FLAGS']) })
				expect(change).toHaveProperty('keys', new Map())
			}
			expect(difference(before, digest("export const FLAGS = make({\nA: 'a',\nB: 'b'\n})"))).toBe('all')
			expect(difference(before, digest("export const FLAGS = Object.freeze({\nA: 'a',\nB: 'b'\n})"))).toBe('all')
		})

		test('a key whose value may do more than make it is a change for every test that loaded the module', () => {
			expect(difference(flags("A: 'a',\nB: make('b'),"), flags("A: 'a',\nB: make('b2'),"))).toBe('all')
			// So is one for a value built from the object that may, and not for one that only makes a value.
			const names = 'export const NAMES = Object.keys(FLAGS)'
			expect(difference(flags("A: 'a',", names), flags("A: 'a2',", names))).toMatchObject({
				values: new Set(['FLAGS', 'NAMES']),
			})
			const told = 'export const TOLD = tell(FLAGS)'
			expect(difference(flags("A: 'a',", told), flags("A: 'a2',", told))).toBe('all')
		})

		test('a value that can reach the other keys makes the object one value', () => {
			expect(digest("export const FLAGS = {\nA: 'a',\nB: () => FLAGS.A,\n}").units['FLAGS']?.keys).toBeUndefined()
			const reads = (code: string) =>
				digest(`import { FLAGS } from './flags.ts'\n${code}`).units['a']?.reads
			// Called off the object, a value gets the object as `this`.
			expect(reads('export const a = () => FLAGS.B()')).toBeUndefined()
			expect(reads('export const a = () => FLAGS.B`text`')).toBeUndefined()
			expect(reads('export const a = () => call(FLAGS.B)')).toEqual({ FLAGS: ['B'] })
		})

		test('a unit of an importer is told apart by the keys it reads', () => {
			const reads = (code: string, file = 'a.ts') =>
				digest(`import { FLAGS } from './flags.ts'\n${code}`, file).units['a']?.reads
			expect(reads('export const a = () => [FLAGS.A, FLAGS?.B, x.FLAGS]')).toEqual({ FLAGS: ['A', 'B'] })
			expect(reads('export const a = () => ({ FLAGS: 1 })')).toEqual({ FLAGS: [] })
			for (const whole of [
				'export const a = () => FLAGS[key]',
				"export const a = () => FLAGS['A']",
				'export const a = () => Object.values(FLAGS)',
				'export const a = () => FLAGS.hasOwnProperty(key)',
				'export const a = () => ({ FLAGS })',
				'export const { a } = FLAGS',
				'export const a = () => <FLAGS.A />',
			]) {
				expect(reads(whole, 'a.tsx')).toBeUndefined()
			}
			// A namespace and a default export are no such constant.
			expect(digest("import all, * as ns from './flags.ts'\nexport const a = () => [all.A, ns.A]").units['a']?.reads).toBeUndefined()
			// One specifier imported twice, called two ways.
			expect(
				digest("import { FLAGS } from './flags.ts'\nimport { FLAGS as ALL } from './flags.ts'\nexport const a = () => [FLAGS.A, ALL.B]").aliases,
			).toEqual({ '?./flags.ts': { FLAGS: ['ALL', 'FLAGS'] } })
			// One module under two specifiers, called two ways.
			const analysis = analyze(
				"import { FLAGS } from './flags.ts'\nimport { FLAGS as ALL } from '~/flags'\nexport const a = () => [FLAGS.A, Object.keys(ALL)]",
				'a.ts',
			)
			expect(
				resolveDigest(analysis!.digest, { './flags.ts': 'flags.ts', '~/flags': 'flags.ts' }).aliases,
			).toEqual({ 'flags.ts': { FLAGS: ['ALL', 'FLAGS'] } })
		})

		test('a test reruns for a key something it ran reads, through re-exports too', () => {
			const at = (code: string, file: string) =>
				resolveDigest(analyze(code, file)!.digest, {
					'./flags.ts': 'flags.ts',
					'./index.ts': 'index.ts',
				})
			const modules = {
				'flags.ts': at("export const FLAGS = {\nA: 'a',\nB: 'b',\n}", 'flags.ts'),
				'index.ts': at("export { FLAGS as F } from './flags.ts'", 'index.ts'),
				'a.ts': at("import { F } from './index.ts'\nexport const a = () => F.A", 'a.ts'),
				'b.ts': at("import { FLAGS as mine } from './flags.ts'\nexport const b = () => mine.B\nexport const other = () => mine.A", 'b.ts'),
				'all.ts': at("import { F } from './index.ts'\nexport const all = () => Object.keys(F)\nexport const one = () => F.A", 'all.ts'),
				'top.ts': at("import { FLAGS } from './flags.ts'\nexport const top = [FLAGS.B]", 'top.ts'),
				'out.ts': at("import { FLAGS } from './flags.ts'\nexport { FLAGS }\nexport const out = () => FLAGS.A", 'out.ts'),
				'ns.ts': at("import * as flags from './flags.ts'\nexport const ns = () => flags", 'ns.ts'),
			}
			const narrowing = new Narrowing(
				modules,
				new Map([['flags.ts', at("export const FLAGS = {\nA: 'a',\nB: 'b2',\nC: 'c',\n}", 'flags.ts')]]),
			)
			const affected = (ran: Record<string, string[]>) =>
				narrowing.affects('flags.ts', {
					deps: new Set(['flags.ts', 'index.ts', ...Object.keys(ran)]),
					ran: { 'flags.ts': [''], 'index.ts': [''], ...ran },
				})
			expect(affected({ 'a.ts': ['', 'a'] })).toBe(false)
			expect(affected({ 'b.ts': ['', 'other'] })).toBe(false)
			expect(affected({ 'b.ts': ['', 'b'] })).toBe(true)
			expect(affected({ 'all.ts': ['', 'one'] })).toBe(false)
			expect(affected({ 'all.ts': ['', 'all'] })).toBe(true)
			expect(affected({ 'top.ts': [''] })).toBe(true)
			expect(affected({ 'out.ts': [''] })).toBe(true)
			expect(affected({ 'ns.ts': [''] })).toBe(true)
			// A module that was not watched may have run any of its functions.
			const unwatched = (file: string) =>
				narrowing.affects('flags.ts', { deps: new Set(['flags.ts', 'index.ts', file]), ran: { 'flags.ts': [''] } })
			expect(unwatched('b.ts')).toBe(true)
			expect(unwatched('a.ts')).toBe(false)
		})
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

	test.each([undefined, 'a.js'])("a marked function's text runs outside its module (key %s)", (key) => {
		const code = 'export function f() {\n\treturn 1\n}\nexport const g = () => 2'
		let marked = code
		const marks = analyze(code, 'a.js', key)?.marks ?? []
		for (const [at, text] of [...marks].sort((a, b) => b[0] - a[0])) {
			marked = marked.slice(0, at) + text + marked.slice(at)
		}
		expect(marks).toHaveLength(3)
		const body = marked.replace(/export /g, '')
		expect(new Function(`${body}\nreturn [f(), g()]`)()).toEqual([1, 2])
		// Nothing of the module's is named, so no transformer can tie the call to it.
		if (key) expect(marked).not.toMatch(/[^.]__blacksmith_hit__/)
	})

	test.each([
		'export function f() {\n\tconst globalThis = 1\n\treturn globalThis\n}',
		'export const f = (globalThis) => globalThis',
		'export function f({ a: [globalThis] }) {}',
		'export function f() {\n\ttry {} catch (globalThis) {}\n}',
		'export function globalThis() {}',
		'export class A {\n\tm(globalThis = 1) {}\n}',
		"import globalThis from './a'\nexport const f = () => globalThis",
	])('a module that binds globalThis is not marked through it: %s', (code) => {
		expect(analyze(code, 'a.js', 'a.js')).toBeNull()
		expect(analyze(code, 'a.js')).not.toBeNull()
		expect(analyze('export const f = () => globalThis.a', 'a.js', 'a.js')).not.toBeNull()
	})

	test('a type annotation in a class with a decorator is code', () => {
		const service = (type: string, decorator: string): string =>
			`import { A, B } from './deps'\nimport { inject } from './inject'\n${decorator}export class Service {\n\tconstructor(private dep: ${type}) {}\n}`
		const plain = digest(service('A', ''), 'a.ts')
		expect(difference(plain, digest(service('B', ''), 'a.ts'))).toBeNull()
		expect(plain.imports).toEqual([])

		const injected = digest(service('A', '@inject()\n'), 'a.ts')
		expect(difference(injected, digest(service('B', '@inject()\n'), 'a.ts'))).not.toBeNull()
		expect(injected.imports).toEqual([
			['?./deps', ['A']],
			['?./inject', ['inject']],
		])
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
