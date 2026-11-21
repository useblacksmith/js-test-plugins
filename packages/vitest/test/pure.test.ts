import vm from 'node:vm'
import { expect, test } from 'vitest'
import { resolveDigest } from '../../core/src/narrow.ts'
import { analyze } from '../../core/src/units.ts'

/**
 * Checks what the analysis calls free of effects against the engine: modules
 * are generated at random, and each one whose last value is told to do no more
 * than make a value is run. Running it must not throw, hang, call anything
 * from outside the module, or leave any other value of the module, or any of
 * the language's, different from what it was.
 */

function random(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const HEAD = "import { ext, EXT } from './ext.js'\n"
const NAMES = ['P', 'L', 'N', 'S', 'Q', 'K', 'ext', 'EXT', 'undefined', 'NaN', 'x', 'y', 'acc']
const KEYS = ['b', 'd', 'f', 'g', 'missing', 'length', 'size', 'toString', 'valueOf', 'constructor', '__proto__', 'x']
const LITERALS = ["'s'", "''", '0', '1', '-1', '1.5', 'true', 'false', 'null', 'undefined', '10n', '1e21', 'NaN', 'Infinity']
const STATIC = [
	'Object.keys', 'Object.values', 'Object.entries', 'Object.assign', 'Object.freeze', 'Object.fromEntries', 'Object.defineProperty',
	'Array.from', 'Array.isArray', 'Array.of', 'JSON.stringify', 'JSON.parse', 'Math.abs', 'Math.floor', 'Math.max', 'String', 'Number',
	'Boolean', 'Symbol', 'BigInt', 'structuredClone', 'ext', 'EXT.f', 'pure', 'pick', 'loop', 'dirty', 'grow', 'build', 'self', 'fill', 'calls', 'later', 'twice',
	'arrow', 'shadow', 'early', 'spin', 'again', 'rest', 'defaults', 'own',
]
const METHODS = [
	'map', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'forEach', 'reduce', 'flatMap', 'flat', 'includes', 'indexOf', 'slice',
	'splice', 'sort', 'reverse', 'toReversed', 'toSorted', 'push', 'pop', 'shift', 'fill', 'concat', 'join', 'at', 'keys', 'entries',
	'toLowerCase', 'toUpperCase', 'trim', 'substring', 'charAt', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll', 'split',
	'startsWith', 'endsWith', 'localeCompare', 'normalize', 'match', 'has', 'get', 'set', 'add', 'delete', 'clear', 'toString', 'valueOf',
	'toFixed', 'hasOwnProperty', 'call', 'bind', 'f',
]
const TAME = new Set(
	[
		"P|L|N|S|Q|K|x|y|b|d|f|g|length|'s'|0|1|true|null|.|?.|Object.keys|Object.values|Object.entries|Array.from|Array.isArray",
		'JSON.stringify|Math.abs|String|Number|Boolean|pure|pick|fill|loop|twice|arrow|map|filter|find|findIndex|some|every|includes',
		'indexOf|slice|toReversed|concat|join|at|toLowerCase|toUpperCase|trim|split|startsWith|has|get|+|===|!=|<|&&|!|typeof ',
		'Set|Map|const|let|=|(x, y)|([x, y])|({ b })|[y]|{ b }',
	]
		.join('|')
		.split('|'),
)
const BINARY = ['+', '-', '*', '/', '%', '**', '==', '===', '!=', '<', '>=', '&&', '||', '??', 'in', 'instanceof', '&', '<<']
const UNARY = ['!', '-', '+', '~', 'typeof ', 'void ', 'delete ']

/** What every module starts with: values of literals, and functions that do and do not keep to themselves. */
const BEFORE = `const P = { b: 's', d: ['e', 'f'], f: { g: 1 }, g: null }
const L = ['h', 'i', P.b]
const N = [3, 1, 2]
const S = 'text'
const Q = { toString: 1, b: 2 }
const K = { valueOf: 's' }
let count = 0
function pure(x) { return [x, 1] }
function pick(x, y) { const out = []; for (const item of L) { if (item !== x) out.push(item) } return out }
function build(x) { const out = []; out.push(x, [out.length]); const more = x ? out : L; for (const item of more) out.push(item); return out }
function self(x) { const out = [x]; out.push(out); return String(out) }
function fill(x) { const out = []; N.map((item) => out.push(item)); const held = { out }; return held.out }
function loop(x) { let found = false; for (const item of N) { if (item === x) found = true } return found }
function dirty(x) { count = count + 1; return x }
function grow(x) { L.push(x); return x }
function calls(x) { return ext(x) }
function later(x) { return () => ext(x) }
function twice(x) { return pure(pure(x)) }
const arrow = (x) => (x === S ? 1 : 2)
function shadow(x) { const y = S; { const S = 1 } return y }
function early(x) { const y = [L]; const L = 1; return y }
function spin(x) { while (x) {} return 1 }
function again(x) { return x ? again(x) : 1 }
function rest(...x) { return x }
function defaults(x = y, y = 1) { return x }
`

function generate(next: () => number): string {
	// Half of the modules lean towards what is accepted, so that much of what is run goes deep.
	const tame = next() < 0.5
	const pick = <T>(from: readonly T[]): T => {
		const kept = tame && next() < 0.85 ? from.filter((item) => typeof item === 'string' && TAME.has(item)) : []
		const among = kept.length > 0 ? kept : from
		return among[Math.floor(next() * among.length)]!
	}
	const list = (depth: number, most: number): string =>
		Array.from({ length: Math.floor(next() * (most + 1)) }, () => (next() < 0.1 ? `...${expression(depth)}` : expression(depth))).join(', ')
	const callback = (depth: number): string => {
		const roll = next()
		if (roll < 0.15) return pick(STATIC)
		const params = pick(['x', '(x, y)', '(acc, x)', '([x, y])', '({ b })', '()', '(x = 1)', '(x = S)', '(P)'])
		if (roll < 0.7) return `${params} => ${expression(depth)}`
		const statements = Array.from({ length: 1 + Math.floor(next() * 3) }, () => statement(depth)).join('; ')
		return roll < 0.9 ? `${params} => { ${statements} }` : `function ${params.startsWith('(') ? params : `(${params})`} { ${statements} }`
	}
	const statement = (depth: number): string => {
		const roll = next()
		if (roll < 0.25) return `return ${expression(depth)}`
		if (roll < 0.4) return `${pick(['const', 'let', 'var'])} ${pick(['y', 'acc', 'S', '{ b }', '[y]'])} = ${expression(depth)}`
		if (roll < 0.5) return `if (${expression(depth)}) { ${statement(depth)} } else { ${statement(depth)} }`
		if (roll < 0.6) return `for (const ${pick(['y', '[y]', 'x'])} of ${expression(depth)}) { ${statement(depth)} }`
		if (roll < 0.7) return `${pick(['x', 'y', 'acc', 'count', 'P.b', 'L[0]', 'x.b'])} ${pick(['=', '+=', '??='])} ${expression(depth)}`
		if (roll < 0.75) return `${pick(['x', 'y', 'count'])}++`
		if (roll < 0.8) return `while (${expression(depth)}) { ${statement(depth)} }`
		return expression(depth)
	}
	const expression = (depth: number): string => {
		const roll = depth <= 0 ? next() * 0.3 : next()
		if (roll < 0.2) return pick(NAMES)
		if (roll < 0.3) return pick(LITERALS)
		if (roll < 0.36) return `[${list(depth - 1, 3)}]`
		if (roll < 0.42) {
			const fields = Array.from({ length: Math.floor(next() * 3) }, () =>
				next() < 0.15 ? `...${expression(depth - 1)}` : `${pick(KEYS)}: ${expression(depth - 1)}`,
			)
			return `({ ${fields.join(', ')} })`
		}
		if (roll < 0.52) return `${expression(depth - 1)}${pick(['.', '.', '?.'])}${pick(KEYS)}`
		if (roll < 0.55) return `${expression(depth - 1)}[${expression(depth - 1)}]`
		if (roll < 0.62) return `(${expression(depth - 1)} ${pick(BINARY)} ${expression(depth - 1)})`
		if (roll < 0.65) return `(${pick(UNARY)}${expression(depth - 1)})`
		if (roll < 0.68) return `(${expression(depth - 1)} ? ${expression(depth - 1)} : ${expression(depth - 1)})`
		if (roll < 0.7) return `\`a\${${expression(depth - 1)}}\``
		if (roll < 0.74) return `new ${pick(['Set', 'Map', 'Date', 'Array', 'String', 'ext'])}(${list(depth - 1, 1)})`
		if (roll < 0.86) return `${pick(STATIC)}(${list(depth - 1, 2)})`
		const method = pick(METHODS)
		const args = next() < 0.6 ? callback(depth - 1) : list(depth - 1, 2)
		return `${expression(depth - 1)}.${method}(${args})`
	}
	const extra = next() < 0.2 ? `${pick(['const M = ', 'const Object = ', 'let T = ', ''])}${expression(2)}\n` : ''
	// A builtin bound anywhere in a module is not the language's for any of it: few modules, so that the rest still tell of objects.
	const bound = next() < 0.1 ? 'function own(Object) { return Object.keys(P) }\n' : ''
	return `${BEFORE}${bound}${extra}export const a = ${expression(3)}\n`
}

/** Runs `code` in a realm of its own and tells what it left behind, or `null` if it threw or did not end. */
function run(code: string): string | null {
	const calls: string[] = []
	const ext = new Proxy(function () {}, {
		apply: () => (calls.push('call'), undefined),
		construct: () => (calls.push('new'), {}),
		set: () => (calls.push('set'), true),
		defineProperty: () => (calls.push('define'), true),
		deleteProperty: () => (calls.push('delete'), true),
		get: (_, key) => (key === 'f' ? ext : undefined),
	})
	const context = vm.createContext({ ext, EXT: ext })
	// What the language itself holds, to tell that none of it was written to.
	const shape = `;(() => {
		const seen = []
		for (const held of [globalThis, Object, Object.prototype, Array, Array.prototype, String.prototype, Number.prototype, Function.prototype, Set.prototype, Map.prototype, JSON, Math]) {
			seen.push(Reflect.ownKeys(held).map(String).join(), Object.isFrozen(held))
		}
		const show = (value) => JSON.stringify(value, (_, held) => typeof held === 'bigint' ? held + 'n' : held === undefined ? 'undefined' : held) + Object.isFrozen(value)
		return JSON.stringify([seen, show(P), show(L), show(N), S, show(Q), show(K), count])
	})()`
	try {
		const left = vm.runInContext(code.replace(HEAD, '').replace(/^export /gm, '') + shape, context, { timeout: 200 })
		return left + calls.join()
	} catch {
		return null
	}
}

test('what is told to have no effect has none when run', () => {
	const next = random(20240607)
	const told = { pure: 0, effects: 0 }
	const wrong: string[] = []
	for (let index = 0; index < 25000; index++) {
		const code = generate(next)
		const analysis = analyze(HEAD + code, 'a.js')
		if (!analysis) continue
		if (resolveDigest(analysis.digest, {}).units['a']?.effects) {
			told.effects++
			continue
		}
		const last = code.lastIndexOf('export const a = ')
		// The module up to its last value: what it must still be after it.
		const before = run(code.slice(0, last))
		if (before === null) continue
		// Without a call nothing is told about it here.
		if (!/[\w\])]\(/.test(code.slice(last).replace(/^export const a = /, ''))) continue
		told.pure++
		if (run(code) !== before) wrong.push(code.slice(BEFORE.length))
	}
	expect(wrong.slice(0, 8)).toEqual([])
	// The check means something only if calls are among what was run.
	expect(told.pure).toBeGreaterThan(300)
	expect(told.effects).toBeGreaterThan(told.pure)
}, 120_000)
