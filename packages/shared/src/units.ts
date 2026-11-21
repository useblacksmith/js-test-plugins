import { createHash } from 'node:crypto'
import { parseSync } from 'oxc-parser'
import { HIT, HITS, LOADED } from './hits.ts'

/**
 * A module split into the pieces a change can be attributed to. Top-level
 * functions run only when called, so a change to one's body matters to the
 * tests that entered it; other top-level declarations run when the module
 * loads, and matter to the tests that loaded a module importing them.
 * Everything else at the top level (`rest`) matters to every test that
 * loaded the module.
 */
export interface Unit {
	/** `f`: a function, entered when called. `v`: evaluated when the module loads. */
	kind: 'f' | 'v'
	/** Hash of what a call evaluates before the body (name, parameters and their defaults). */
	sig: string
	/** Hash of the body (`f`) or of the whole declaration (`v`), types and comments left out. */
	body: string
	/** The module's other top-level names (imports included) the unit mentions. */
	refs: string[]
	/**
	 * For a `const` holding an object literal of plain keys: each key with the
	 * hash of its value, so a change to one key is a change for what reads that key.
	 */
	keys?: Record<string, string>
	/** Hash of that declaration around its properties. */
	frame?: string
	/**
	 * Those of `refs` the unit only reads keys of (`X.key`), with the keys: such
	 * constants of the module, and names it imports, which may hold one.
	 */
	reads?: Record<string, string[]>
	/**
	 * For a `v`: evaluating it may do more than make the value (it calls
	 * something, constructs, assigns), which every test that loaded the module saw.
	 */
	effects?: true
}

/** A value import: the module specifier and the names taken from it, `'*'` for all of them. */
export type Import = [specifier: string, names: string[] | '*']

export interface Digest {
	rest: string
	restRefs: string[]
	/** As `Unit.reads`, for the statements of `rest`. */
	restReads?: Record<string, string[]>
	/** In source order. */
	units: Record<string, Unit>
	/** Exported name → the unit (or imported local) it names. */
	exports: Record<string, string>
	/** Exported name → where it is re-exported from; `'*'` as the name for `export * as ns`. */
	reexports: Record<string, [specifier: string, name: string]>
	/** Specifiers of `export * from`. */
	stars: string[]
	/** Bindings the module itself uses; re-exports are not among them. */
	imports: Import[]
	/** Specifier → imported name → what the module calls it, where that is not just the name. */
	aliases?: Record<string, Record<string, string[]>>
	/** Every specifier the module loads statically, in order. */
	sources: string[]
	/** How many of `sources` come first, in order, as the module loads. */
	linked: number
	/** The module may take any name from a module the analysis cannot name. */
	wild: boolean
	/**
	 * A CommonJS module, which `analyze` only describes when asked: what it
	 * loads is known, and any change to it is a change to all of it.
	 */
	opaque?: true
}

export interface Analysis {
	digest: Digest
	/** Insertions that make each `f` unit report its first statement running: offset, text. */
	marks: Array<[number, string]>
}

type Node = { type: string; start: number; end: number; [key: string]: any }

/** The identifiers a stretch of code mentions, and how it uses each. */
class Ids extends Set<string> {
	/** Mentioned as a value, which may be read in any way. */
	readonly whole = new Set<string>()
	/** Name → the keys read off it as `name.key`. */
	readonly parts = new Map<string, Set<string>>()

	absorb(other: Ids): void {
		for (const id of other) this.add(id)
		for (const id of other.whole) this.whole.add(id)
		for (const [id, keys] of other.parts) for (const key of keys) this.read(id, key)
	}

	read(id: string, key: string): void {
		const keys = this.parts.get(id)
		if (keys) keys.add(key)
		else this.parts.set(id, new Set([key]))
	}

	/** The keys read off `id`, when that is all that is done with it. */
	readsOf(id: string): string[] | null {
		return this.whole.has(id) ? null : [...(this.parts.get(id) ?? [])].sort()
	}
}

/** What every object has without holding it as a key: reading one is not reading a key of the literal. */
const inherited = (key: string): boolean => key in {}

const VALUE_TS = new Set([
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
	'TSInstantiationExpression',
	'TSEnumDeclaration',
	'TSEnumBody',
	'TSEnumMember',
	'TSModuleDeclaration',
	'TSModuleBlock',
	'TSParameterProperty',
])

/** Calls that load a module the import graph does not show. */
const LOADERS = new Set([
	'require',
	'mock',
	'doMock',
	'unmock',
	'doUnmock',
	'importActual',
	'importMock',
	'requireActual',
	'requireMock',
])

function hash(text: string): string {
	return createHash('sha1').update(text).digest('base64').slice(0, 12)
}

function lang(file: string): 'js' | 'jsx' | 'ts' | 'tsx' | null {
	const match = /\.([cm]?)([jt])s(x?)$/.exec(file)
	if (!match || /\.d\.[cm]?ts$/.test(file)) return null
	if (match[2] === 't') return match[3] ? 'tsx' : 'ts'
	// JSX in a `.js` file is common; a `.mjs` or `.cjs` one is plain.
	return match[1] ? 'js' : 'jsx'
}

function unwrap(node: Node | null | undefined): Node | null {
	while (
		node &&
		(node.type === 'ParenthesizedExpression' ||
			node.type === 'TSAsExpression' ||
			node.type === 'TSSatisfiesExpression' ||
			node.type === 'TSNonNullExpression')
	) {
		node = node.expression
	}
	return node ?? null
}

const EFFECTS = new Set([
	'AwaitExpression',
	'YieldExpression',
	'AssignmentExpression',
	'UpdateExpression',
	'ImportExpression',
	'StaticBlock',
	'Decorator',
])

/** What the language provides that only makes a value: `Object.keys(x)`, `new Set(x)`, `String(x)`. */
const STATICS: Record<string, ReadonlySet<string> | true> = {
	Object: new Set(['keys', 'values', 'entries', 'fromEntries', 'freeze', 'isFrozen', 'hasOwn', 'getOwnPropertyNames']),
	Array: new Set(['from', 'of', 'isArray']),
	Number: true,
	String: true,
	Math: true,
	JSON: new Set(['stringify']),
}
const CALLED = new Set(['Number', 'String', 'Boolean', 'BigInt', 'Symbol'])
const MADE = new Set(['Set', 'Map', 'WeakSet', 'WeakMap', 'Date', 'RegExp', 'Array', 'Error', 'URL', 'URLSearchParams'])
/** Methods of an array, a string, a `Set` or a `Map` that leave it as it was. Those that take a function call it. */
const METHODS = new Set(
	(
		'map filter flatMap flat slice concat join includes indexOf lastIndexOf find findIndex findLast findLastIndex ' +
		'some every reduce reduceRight at keys values entries toSorted toReversed with ' +
		'trim trimStart trimEnd split toLowerCase toUpperCase startsWith endsWith replace replaceAll padStart padEnd ' +
		'repeat substring charAt has get toString'
	).split(' '),
)

/** Those of `METHODS` that call a function they are given. */
const CALLING = new Set(
	'map filter flatMap find findIndex findLast findLastIndex some every reduce reduceRight toSorted replace replaceAll'.split(' '),
)

/**
 * Whether evaluating `node` may do more than make a value: what a function or
 * an instance runs later is left out. `own` tells a name the module declares
 * or imports, which is then not the language's.
 */
function effects(node: Node | null | undefined, own: (name: string) => boolean): boolean {
	if (!node || typeof node !== 'object') return false
	if (Array.isArray(node)) return node.some((child) => effects(child, own))
	if (typeof node.type !== 'string') return false
	if (EFFECTS.has(node.type)) return true
	if (node.type === 'UnaryExpression' && node.operator === 'delete') return true
	if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') return false
	if (node.type === 'FunctionDeclaration') return false
	if (node.type === 'TaggedTemplateExpression') return true
	if (node.type === 'NewExpression') {
		const made = unwrap(node.callee)
		if (made?.type !== 'Identifier' || !MADE.has(made.name) || own(made.name)) return true
		return effects(node.arguments, own)
	}
	if (node.type === 'CallExpression') {
		const callee = unwrap(node.callee)
		const args = node.arguments as Node[]
		if (callee?.type === 'Identifier') {
			return !CALLED.has(callee.name) || own(callee.name) || args.some((arg) => effects(arg, own))
		}
		if (callee?.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return true
		const method = callee.property.name as string
		const object = unwrap(callee.object)
		if (object?.type === 'Identifier' && Object.hasOwn(STATICS, object.name) && !own(object.name)) {
			const methods = STATICS[object.name]!
			if (methods !== true && !methods.has(method)) return true
			// `Array.from(x, fn)` calls `fn`.
			const takes = object.name === 'Array' && method === 'from'
			return args.some((arg, index) => (takes && index > 0 ? called(arg, own) : effects(arg, own)))
		}
		if (!METHODS.has(method) || !builtin(object, own)) return true
		return effects(object, own) || args.some((arg) => (CALLING.has(method) ? called(arg, own) : effects(arg, own)))
	}
	// A decorator runs as the class is made, whatever it is on.
	if (node.type === 'MethodDefinition') {
		return (
			effects(node.decorators, own) ||
			(node.value?.params as Node[] | undefined)?.some((param) => effects(param.decorators, own)) ||
			(node.computed ? effects(node.key, own) : false)
		)
	}
	if (node.type === 'PropertyDefinition' && !node.static) {
		return effects(node.decorators, own) || (node.computed ? effects(node.key, own) : false)
	}
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end') continue
		if (key === 'typeAnnotation' || key === 'typeArguments' || key === 'typeParameters') continue
		const child = node[key]
		if (child && typeof child === 'object' && effects(child, own)) return true
	}
	return false
}

/** An argument of a call that may call it: a function written there runs, any other may be one. */
function called(arg: Node, own: (name: string) => boolean): boolean {
	const value = unwrap(arg)
	if (!value) return false
	if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
		return value.async || value.generator || effects(value.params, own) || effects(value.body, own)
	}
	if (value.type === 'Literal' || value.type === 'TemplateLiteral') return effects(value, own)
	if (value.type === 'SpreadElement') return true
	// A name or a member may hold a function; what else is written there is a value.
	if (value.type === 'Identifier' || value.type === 'MemberExpression') return true
	return effects(value, own)
}

/** Whether `node` is written as an array, a string, a `Set` or a `Map` of the language's: a literal, or what such a call gives. */
function builtin(node: Node | null, own: (name: string) => boolean): boolean {
	if (!node) return false
	if (node.type === 'ArrayExpression' || node.type === 'TemplateLiteral') return true
	if (node.type === 'Literal') return typeof node.value === 'string'
	if (node.type === 'NewExpression') {
		const made = unwrap(node.callee)
		return made?.type === 'Identifier' && ['Set', 'Map', 'Array'].includes(made.name) && !own(made.name)
	}
	if (node.type !== 'CallExpression') return false
	const callee = unwrap(node.callee)
	if (callee?.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return false
	const method = callee.property.name as string
	const object = unwrap(callee.object)
	if (object?.type === 'Identifier' && !own(object.name)) {
		if (object.name === 'Object') return ['keys', 'values', 'entries', 'getOwnPropertyNames'].includes(method)
		if (object.name === 'Array') return method === 'from' || method === 'of'
	}
	// What these give of an array or a string is one again.
	const same = 'map filter flatMap flat slice concat toSorted toReversed with split trim trimStart trimEnd toLowerCase toUpperCase'
	return same.split(' ').includes(method) && builtin(object, own)
}

function isFunction(node: Node | null): node is Node {
	return (
		node?.type === 'ArrowFunctionExpression' ||
		node?.type === 'FunctionExpression' ||
		node?.type === 'FunctionDeclaration'
	)
}

function bound(pattern: Node | null, names: string[]): string[] {
	if (!pattern) return names
	switch (pattern.type) {
		case 'Identifier':
			names.push(pattern.name)
			break
		case 'ObjectPattern':
			for (const property of pattern.properties) {
				bound(property.type === 'RestElement' ? property.argument : property.value, names)
			}
			break
		case 'ArrayPattern':
			for (const element of pattern.elements) bound(element, names)
			break
		case 'AssignmentPattern':
			bound(pattern.left, names)
			break
		case 'RestElement':
			bound(pattern.argument, names)
			break
	}
	return names
}

/**
 * `null` for a file whose changes cannot be attributed to anything smaller
 * than the file: not JavaScript or TypeScript, unparsable, CommonJS, or
 * already using the instrumentation's names. With `key` the marks report to
 * the function `installHit` leaves on `globalThis`, as `globalFooter(key)`
 * does; without, to the one `footer` declares in the module.
 *
 * With `loads`, a CommonJS module gets a digest too, of what it loads and
 * nothing else (`opaque`): it is not marked, and its own changes still reach
 * every test that loaded it, but a change elsewhere reaches it only through
 * a module it requires.
 */
export function analyze(code: string, file: string, key?: string, loads = false): Analysis | null {
	const language = lang(file)
	if (!language || code.includes(HIT)) return null
	let program: Node
	let comments: Array<{ start: number; end: number }>
	try {
		const result = parseSync(file, code, { lang: language, sourceType: 'module' })
		if (result.errors.some((error) => error.severity === 'Error')) return null
		program = result.program as unknown as Node
		comments = result.comments
	} catch {
		return null
	}
	const typescript = language === 'ts' || language === 'tsx'
	// Stretches of source that never reach the runtime: types and comments.
	const holes: Array<[number, number]> = comments.map((c) => [c.start, c.end])
	let opaque = false
	let wild = false
	// What makes a module opaque, and whether what it loads can still be named.
	let commonjs = false
	let unnamed = false
	let requires = 0
	let required = 0
	const loaded: Import[] = []

	const literal = (node: Node | undefined): string | null => {
		const value = unwrap(node)
		if (value?.type === 'Literal' && typeof value.value === 'string') return value.value
		if (value?.type === 'TemplateLiteral' && value.expressions.length === 0) {
			return value.quasis[0]?.value.cooked ?? null
		}
		// `vi.mock(import('./module'))`
		if (value?.type === 'ImportExpression') return literal(value.source)
		return null
	}

	// Inside a class with a decorator, type annotations reach the runtime: a
	// transformer that emits decorator metadata turns them into values
	// (`design:paramtypes`), which is how dependency injection picks what to pass.
	// A mark with a `key` goes through `globalThis`, which a module may bind to something else.
	const mayShadow = key !== undefined && code.includes('globalThis')
	let metadata = 0
	const mayDecorate = typescript && code.includes('@')
	const decorated = (node: unknown): boolean => {
		if (!mayDecorate || !node || typeof node !== 'object') return false
		if (Array.isArray(node)) return node.some(decorated)
		const n = node as Node
		if (Array.isArray(n.decorators) && n.decorators.length > 0) return true
		for (const key in n) {
			const child = n[key]
			if (child && typeof child === 'object' && decorated(child)) return true
		}
		return false
	}

	/** Collects the identifiers `node` mentions as values into `ids`. */
	const walk = (node: unknown, ids: Ids): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child, ids)
			return
		}
		if (!node || typeof node !== 'object') return
		const n = node as Node
		if (typeof n.type !== 'string') return
		if (
			(n.type.startsWith('TS') && !VALUE_TS.has(n.type) && metadata === 0) ||
			n.declare === true ||
			n.importKind === 'type' ||
			n.exportKind === 'type'
		) {
			if (n.type === 'TSExportAssignment' || n.type === 'TSImportEqualsDeclaration') {
				opaque = true
				unnamed = true
			}
			holes.push([n.start, n.end])
			return
		}
		if (mayShadow) {
			const declared: Array<string | undefined> = []
			if (n.type === 'VariableDeclarator') bound(n.id, declared as string[])
			if (n.type === 'CatchClause') bound(n.param, declared as string[])
			if (n.type.startsWith('Class') || n.type.includes('Function')) declared.push(n.id?.name)
			for (const param of (n.params ?? []) as Node[]) {
				bound(param.type === 'TSParameterProperty' ? param.parameter : param, declared as string[])
			}
			if (declared.includes('globalThis')) {
				opaque = true
				unnamed = true
			}
		}
		if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && decorated(n)) {
			metadata++
			children(n, ids)
			metadata--
			return
		}
		switch (n.type) {
			case 'Identifier':
			case 'JSXIdentifier':
				ids.add(n.name)
				ids.whole.add(n.name)
				if (n.name === 'require') requires++
				if (n.name === 'eval') {
					opaque = true
					unnamed = true
				}
				break
			case 'Property':
				// A plain key names nothing; what it is kept as a mention for is the hash, which has always had it.
				if (!n.computed && !n.shorthand && n.key.type === 'Identifier') {
					ids.add(n.key.name)
					walk(n.value, ids)
					return
				}
				break
			case 'MemberExpression':
				if (
					(n.object.type === 'Identifier' &&
						n.object.name === 'module' &&
						n.property.name === 'exports') ||
					(n.object.type === 'Identifier' && n.object.name === 'exports')
				) {
					opaque = true
					commonjs = true
				}
				if (
					n.object.type === 'MetaProperty' &&
					typeof n.property.name === 'string' &&
					n.property.name.startsWith('glob')
				) {
					wild = true
				}
				// `X.key` reads one key of `X`, and `x.name` mentions no `name`.
				if (!n.computed && n.property.type === 'Identifier') {
					const key: string = n.property.name
					if (n.object.type === 'Identifier' && !inherited(key)) {
						ids.add(n.object.name)
						ids.read(n.object.name, key)
						if (n.object.name === 'require') requires++
						if (n.object.name === 'eval') {
							opaque = true
							unnamed = true
						}
					} else {
						walk(n.object, ids)
					}
					ids.add(key)
					if (key === 'require') requires++
					return
				}
				break
			case 'ImportExpression': {
				const source = literal(n.source)
				if (source === null) wild = true
				else loaded.push([source, '*'])
				break
			}
			case 'TaggedTemplateExpression': {
				// `X.key()` hands `X` to what it calls as `this`, which may read any key.
				const called = unwrap(n.tag)
				if (called?.type === 'MemberExpression' && called.object.type === 'Identifier') {
					ids.whole.add(called.object.name)
				}
				break
			}
			case 'CallExpression': {
				const callee = unwrap(n.callee)
				if (callee?.type === 'MemberExpression' && callee.object.type === 'Identifier') {
					ids.whole.add(callee.object.name)
				}
				const name =
					callee?.type === 'Identifier'
						? callee.name
						: callee?.type === 'MemberExpression' && !callee.computed
							? callee.property.name
							: null
				if (
					name !== null &&
					LOADERS.has(name) &&
					(name === 'require' ? callee?.type === 'Identifier' : callee?.type !== 'Identifier')
				) {
					const source = literal(n.arguments[0])
					if (source === null) wild = true
					else {
						loaded.push([source, '*'])
						if (name === 'require') required++
					}
				}
				break
			}
		}
		children(n, ids)
	}

	const children = (n: Node, ids: Ids): void => {
		for (const key in n) {
			if (key === 'type' || key === 'start' || key === 'end') continue
			const child = n[key]
			if (child && typeof child === 'object') walk(child, ids)
		}
	}

	interface Draft {
		name: string
		kind: 'f' | 'v'
		start: number
		split: number
		end: number
		prefix: string
		ids: Ids
		/** For a `v`: what is evaluated as the module loads. */
		evaluated?: Node
		/** For an object literal of plain keys: where it is, and each key with its value. */
		object?: { start: number; end: number; keys: Array<{ key: string; start: number; end: number; ids: Ids }> }
	}
	const drafts: Draft[] = []
	const rest: Array<{ start: number; end: number } | string> = []
	const restIds = new Ids()
	const exports: Record<string, string> = {}
	const reexports: Digest['reexports'] = {}
	const stars: string[] = []
	const imported: Array<{ source: string; names: Array<[imported: string, local: string]> }> = []
	// The modules a static import or re-export names, in the order they are evaluated.
	const linked: Array<string | (typeof imported)[number]> = []
	const bindings = new Map<string, string>()
	const marks: Analysis['marks'] = []

	const mark = (name: string, fn: Node): void => {
		const body = fn.body as Node
		// A function's text may be run somewhere else (`fn.toString()` into an inline script),
		// where the call must do nothing. With a `key` it names nothing of the module's.
		const call =
			key === undefined
				? `typeof ${HIT}=="function"&&${HIT}(${JSON.stringify(name)})`
				: `globalThis.${HIT}?.(${JSON.stringify(key)},${JSON.stringify(name)})`
		if (body.type !== 'BlockStatement' && body.type !== 'FunctionBody') {
			marks.push([body.start, `(${call},`], [body.end, ')'])
			return
		}
		let at = body.start + 1
		let separator = ''
		for (const statement of body.body as Node[]) {
			if (statement.type !== 'ExpressionStatement' || !statement.directive) break
			at = statement.end
			// A directive may end without a semicolon.
			separator = ';'
		}
		marks.push([at, `${separator}${call};`])
	}

	/**
	 * The keys of an object literal a `const` holds, when each is a plain key
	 * with a value of its own: no spread, computed key, accessor or method, and
	 * no function that could reach the other keys through `this`.
	 */
	const keysOf = (name: string, value: Node | null): Draft['object'] => {
		if (value?.type !== 'ObjectExpression') return undefined
		const keys: NonNullable<Draft['object']>['keys'] = []
		const seen = new Set<string>()
		for (const property of value.properties as Node[]) {
			if (property.type !== 'Property' || property.computed || property.kind !== 'init') return undefined
			if (property.method || unwrap(property.value)?.type === 'FunctionExpression') return undefined
			const key =
				property.key.type === 'Identifier'
					? (property.key.name as string)
					: property.key.type === 'Literal' && typeof property.key.value === 'string'
						? (property.key.value as string)
						: null
			if (key === null || inherited(key) || seen.has(key)) return undefined
			seen.add(key)
			const ids = new Ids()
			walk(property.value, ids)
			// A value that mentions the object may read its other keys.
			if (ids.has(name)) return undefined
			keys.push({ key, start: property.value.start, end: property.value.end, ids })
		}
		return { start: value.start, end: value.end, keys }
	}

	const unit = (name: string, node: Node, value: Node | null, prefix: string): void => {
		const ids = new Ids()
		walk(node, ids)
		const fn = unwrap(value)
		if (isFunction(fn) && fn.body) {
			drafts.push({ name, kind: 'f', start: node.start, split: fn.body.start, end: node.end, prefix, ids })
			mark(name, fn)
		} else {
			const object = prefix === 'const ' ? keysOf(name, fn) : undefined
			drafts.push({
				name,
				kind: 'v',
				start: node.start,
				split: node.start,
				end: node.end,
				prefix,
				ids,
				evaluated: node,
				...(object ? { object } : {}),
			})
		}
	}

	const declaration = (node: Node, exported: boolean): void => {
		switch (node.type) {
			case 'FunctionDeclaration':
				if (!node.body) return void holes.push([node.start, node.end])
				unit(node.id.name, node, node, '')
				if (exported) exports[node.id.name] = node.id.name
				return
			case 'ClassDeclaration':
			case 'TSEnumDeclaration':
				unit(node.id.name, node, null, '')
				if (exported) exports[node.id.name] = node.id.name
				return
			case 'VariableDeclaration':
				for (const declarator of node.declarations as Node[]) {
					const names = bound(declarator.id, [])
					if (declarator.id.type === 'Identifier') {
						unit(declarator.id.name, declarator, declarator.init, `${node.kind} `)
					} else {
						for (const name of names) unit(name, declarator, null, `${node.kind} `)
					}
					if (exported) for (const name of names) exports[name] = name
				}
				return
			default:
				rest.push(node)
				walk(node, restIds)
		}
	}

	for (const node of program.body as Node[]) {
		if (
			(node.type.startsWith('TS') && !VALUE_TS.has(node.type)) ||
			node.declare === true ||
			node.importKind === 'type' ||
			node.exportKind === 'type'
		) {
			walk(node, restIds)
			continue
		}
		switch (node.type) {
			case 'ImportDeclaration': {
				const names: Array<[string, string]> = []
				for (const specifier of node.specifiers as Node[]) {
					if (specifier.importKind === 'type') continue
					const name =
						specifier.type === 'ImportDefaultSpecifier'
							? 'default'
							: specifier.type === 'ImportNamespaceSpecifier'
								? '*'
								: (specifier.imported.name ?? specifier.imported.value)
					names.push([name, specifier.local.name])
					if (mayShadow && specifier.local.name === 'globalThis') {
						opaque = true
						unnamed = true
					}
				}
				// TypeScript drops an import that names only types.
				if (node.specifiers.length > 0 && names.length === 0) break
				imported.push({ source: node.source.value, names })
				linked.push(imported[imported.length - 1]!)
				break
			}
			case 'ExportAllDeclaration': {
				const source: string = node.source.value
				linked.push(source)
				if (node.exported) {
					reexports[node.exported.name ?? node.exported.value] = [source, '*']
				} else {
					stars.push(source)
				}
				rest.push(`export * ${source}`)
				break
			}
			case 'ExportNamedDeclaration': {
				if (node.declaration) {
					declaration(node.declaration, true)
					break
				}
				// TypeScript drops a re-export that names only types.
				const kept =
					node.specifiers.length === 0 ||
					(node.specifiers as Node[]).some((specifier) => specifier.exportKind !== 'type')
				if (node.source && node.exportKind !== 'type' && kept) linked.push(node.source.value)
				for (const specifier of node.specifiers as Node[]) {
					if (specifier.exportKind === 'type') continue
					const local: string = specifier.local.name ?? specifier.local.value
					const name: string = specifier.exported.name ?? specifier.exported.value
					if (node.source) reexports[name] = [node.source.value, local]
					else exports[name] = local
				}
				if (node.source && node.exportKind !== 'type' && kept) {
					rest.push(`export from ${node.source.value}`)
				}
				break
			}
			case 'ExportDefaultDeclaration': {
				const value = node.declaration as Node
				if (value.type === 'Identifier') {
					exports['default'] = value.name
					restIds.add(value.name)
				} else if (
					(value.type === 'FunctionDeclaration' || value.type === 'ClassDeclaration') &&
					value.id
				) {
					declaration(value, false)
					exports['default'] = value.id.name
				} else if (value.type.startsWith('TS') && !VALUE_TS.has(value.type)) {
					walk(value, restIds)
				} else {
					unit('default', node, value, '')
					exports['default'] = 'default'
				}
				break
			}
			default:
				declaration(node, false)
		}
	}
	if (opaque && !(loads && commonjs)) return null
	const names = new Set<string>()
	for (const draft of drafts) {
		// Two declarations of one name (`var` twice, a function redeclared).
		if (names.has(draft.name) && draft.kind === 'f') return null
		names.add(draft.name)
	}

	const own = (name: string): boolean =>
		names.has(name) || imported.some((entry) => entry.names.some(([, local]) => local === name))

	holes.sort((a, b) => a[0] - b[0])
	const text = (start: number, end: number): string => {
		let out = ''
		let at = start
		for (const [from, to] of holes) {
			if (to <= at) continue
			if (from >= end) break
			if (from > at) out += code.slice(at, from)
			at = Math.max(at, to)
		}
		return at < end ? out + code.slice(at, end) : out
	}

	// What a mentioned name stands for; a name that is neither is a global.
	const used = new Set<string>(restIds)
	for (const draft of drafts) for (const id of draft.ids) used.add(id)
	const dropped = new Set<(typeof imported)[number]>()
	const imports: Import[] = [...loaded]
	for (const entry of imported) {
		const { source, names: pairs } = entry
		// TypeScript drops the names a file never uses as values, and the
		// import with them when none is left.
		const kept = typescript ? pairs.filter(([, local]) => used.has(local)) : pairs
		if (pairs.length > 0 && kept.length === 0) {
			dropped.add(entry)
			continue
		}
		for (const [name, local] of kept) bindings.set(local, `${source}\0${name}`)
		imports.push([
			source,
			kept.some(([name]) => name === '*') ? '*' : kept.map(([name]) => name),
		])
	}
	const sources: string[] = []
	for (const entry of linked) {
		if (typeof entry === 'string') sources.push(entry)
		else if (!dropped.has(entry)) sources.push(entry.source)
	}
	const first = new Set(sources).size
	for (const [source] of loaded) sources.push(source)

	const refsOf = (ids: ReadonlySet<string>, self: string | null): string[] =>
		[...ids].filter((id) => id !== self && (names.has(id) || bindings.has(id))).sort()
	const resolved = (refs: string[]): string =>
		refs.map((ref) => `${ref}=${bindings.get(ref) ?? ''}`).join('\n')

	// A value nothing exports or mentions is there for what evaluating it
	// does, like any other top-level statement.
	const mentioned = new Set<string>(restIds)
	for (const draft of drafts) {
		for (const id of draft.ids) if (id !== draft.name) mentioned.add(id)
	}
	const exportedLocals = new Set(Object.values(exports))
	// The constants whose keys a change is told apart by: declared once, and read by something.
	const keyed = new Set<string>()
	const declared = new Map<string, number>()
	for (const draft of drafts) declared.set(draft.name, (declared.get(draft.name) ?? 0) + 1)
	for (const draft of drafts) {
		if (draft.object && declared.get(draft.name) === 1) keyed.add(draft.name)
	}
	// Imported by name: a namespace or a default export holds no such constant.
	const named = new Set<string>()
	let aliases: Digest['aliases']
	const locals = new Map<string, Map<string, Set<string>>>()
	for (const entry of imported) {
		if (dropped.has(entry)) continue
		for (const [name, local] of entry.names) {
			if (!bindings.has(local) || name === '*') continue
			if (name !== 'default' && !names.has(local)) named.add(local)
			let of = locals.get(entry.source)
			if (!of) locals.set(entry.source, (of = new Map()))
			const list = of.get(name)
			if (list) list.add(local)
			else of.set(name, new Set([local]))
		}
	}
	// One specifier may be imported more than once, a name taken each time its own way.
	for (const [source, of] of locals) {
		for (const [name, list] of of) {
			if (list.size === 1 && list.has(name)) continue
			;((aliases ??= {})[source] ??= {})[name] = [...list].sort()
		}
	}
	const readsOf = (ids: Ids, refs: string[]): Record<string, string[]> | undefined => {
		let reads: Record<string, string[]> | undefined
		for (const ref of refs) {
			const keys = keyed.has(ref) || named.has(ref) ? ids.readsOf(ref) : null
			if (keys) (reads ??= {})[ref] = keys
		}
		return reads
	}
	const units: Record<string, Unit> = {}
	const restParts: string[] = []
	for (const part of rest) {
		restParts.push(typeof part === 'string' ? part : text(part.start, part.end))
	}
	for (const draft of drafts) {
		const refs = refsOf(draft.ids, draft.name)
		if (draft.kind === 'v' && !exportedLocals.has(draft.name) && !mentioned.has(draft.name)) {
			restParts.push(draft.prefix + text(draft.start, draft.end))
			restIds.absorb(draft.ids)
			continue
		}
		const tail = `\n${resolved(refs)}`
		const previous = Object.hasOwn(units, draft.name) ? units[draft.name] : undefined
		const next: Unit = {
			kind: draft.kind,
			sig: hash(draft.prefix + text(draft.start, draft.split)),
			body: hash(text(draft.split, draft.end) + tail),
			refs,
		}
		const reads = readsOf(draft.ids, refs)
		if (reads) next.reads = reads
		if ((draft.evaluated && effects(draft.evaluated, own)) || previous?.effects) next.effects = true
		if (draft.object && keyed.has(draft.name)) {
			const { object } = draft
			next.frame = hash(`${draft.prefix}${text(draft.start, object.start)}\0${text(object.end, draft.end)}`)
			next.keys = {}
			for (const { key, start, end, ids } of object.keys) {
				next.keys[key] = hash(`${text(start, end)}\n${resolved(refsOf(ids, null))}`)
			}
		}
		// One destructuring declares several names; a repeated `var` keeps both texts.
		units[draft.name] = previous
			? {
					kind: 'v',
					sig: hash(previous.sig + next.sig),
					body: hash(previous.body + next.body),
					refs: [...new Set([...previous.refs, ...refs])].sort(),
					...(next.effects ? { effects: true as const } : {}),
				}
			: next
	}
	if (opaque) {
		// `require` handed on or looked up some other way, or exports passed on: it may load or hold anything.
		const any =
			wild ||
			unnamed ||
			requires > required ||
			/\bcreateRequire\b|['"`]require['"`]/.test(code) ||
			stars.length > 0 ||
			Object.keys(reexports).length > 0
		const all = [...new Set(sources)]
		return {
			digest: {
				rest: hash(code),
				restRefs: [],
				units: {},
				exports: {},
				reexports: {},
				stars: [],
				imports: all.map((source) => [source, '*']),
				sources: all,
				linked: first,
				wild: any,
				opaque: true,
			},
			marks: [],
		}
	}
	const restRefs = refsOf(restIds, null)
	const restReads = readsOf(restIds, restRefs)
	return {
		digest: {
			rest: hash(`${restParts.join('\n')}\n${resolved(restRefs)}`),
			restRefs,
			...(restReads ? { restReads } : {}),
			units,
			exports,
			reexports,
			stars,
			imports,
			...(aliases ? { aliases } : {}),
			sources: [...new Set(sources)],
			linked: first,
			wild,
		},
		marks,
	}
}

/**
 * What a marked module ends with: every top-level function reports to
 * `HITS[key]` when it is entered. `typed` is the same in a form a strict
 * TypeScript check accepts, for a transformer that type-checks what it is given.
 */
export function footer(key: string, typed = false): string {
	const loaded = `${HIT}(${JSON.stringify(LOADED)});`
	if (!typed) {
		return `\n;function ${HIT}(n){(${HIT}.t??=((globalThis.${HITS}??={})[${JSON.stringify(key)}]??={}))[n]=1}${loaded}`
	}
	// The table is looked up on first use: a hoisted function may run before this line does.
	const table = `${HIT}_t`
	// Two semicolons: a transformer may take the first as the end of the statement before and write after it.
	return `\n;;var ${table}=Function("return")();function ${HIT}(n=""){(${table}??=((Function("return this")().${HITS}??={})[${JSON.stringify(key)}]??={}))[n]=1}${loaded}`
}

/**
 * What a module marked with a `key` ends with. Nothing in it or in the marks
 * belongs to the module, so a transformer that knows the module's
 * declarations cannot simplify a mark into one that only runs inside it.
 */
export function globalFooter(key: string): string {
	return `\n;globalThis.${HIT}?.(${JSON.stringify(key)},${JSON.stringify(LOADED)});`
}
