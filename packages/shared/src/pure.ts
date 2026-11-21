/**
 * Whether a call written in a module runs only the language's own code and
 * functions of the module that do the same, on values the module wrote itself.
 *
 * Nothing that is accepted here writes to a value that already exists: no
 * assignment but to a variable of the function that makes it, no method that
 * changes what it is called on. So a value stays as it was written, and
 * `value` can tell what it is (`Val`) and that no call made on it throws.
 * What is not known to be such a value (an import, a `let`, what an unknown
 * call gives, a function) is refused wherever it would be handed to a call.
 */

type Node = { type: string; start: number; end: number; [key: string]: any }

export type Kind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'set' | 'map' | null

/** What a value is known to be: `kind` null is a value of literals of a kind that is not known, which may be `null` or `undefined`. */
export interface Val {
	kind: Kind
	/** What an array or a set holds, or the values of an object. */
	of?: Val
	/** The keys an object was written with. */
	fields?: Map<string, Val>
	/** An array the function being run made itself and adds to: nothing else holds it yet. */
	own?: true
	/** It may be, or hold, such an array. */
	tied?: true
}

/** Whether `val` is, or holds, an array that is still added to. */
function growing(val: Val): boolean {
	if (val.own || val.tied || (val.of && growing(val.of))) return true
	if (val.fields) for (const field of val.fields.values()) if (growing(field)) return true
	return false
}

/** `val` once what made it is done: nothing adds to it any more. */
export function settled(val: Val): Val {
	if (!growing(val)) return val
	const { own: _, tied: __, ...rest } = val
	if (rest.of) rest.of = settled(rest.of)
	if (rest.fields) rest.fields = new Map([...rest.fields].map(([key, field]) => [key, settled(field)]))
	return rest
}

/** The names a stretch of code can read, innermost first. */
export class Scope {
	private readonly vars = new Map<string, Val>()
	readonly parent: Scope | undefined
	constructor(parent?: Scope) {
		this.parent = parent
	}
	get(name: string): Val | undefined {
		return this.vars.get(name) ?? this.parent?.get(name)
	}
	/** The scope that declares `name`. */
	holder(name: string): Scope | undefined {
		return this.vars.has(name) ? this : this.parent?.holder(name)
	}
	set(name: string, val: Val): void {
		this.vars.set(name, val)
	}
	clear(): void {
		this.vars.clear()
	}
}

export interface Module {
	/** A name the module declares or imports at its top level. */
	own(name: string): boolean
	/** Whether the module binds `name` in some scope, hands it on, or writes to a key of it: it may then not be the language's. */
	taken(name: string): boolean
	/** The functions declared at the top level that are never assigned to. */
	fns: Map<string, Node>
	/** The `const`s of the top level that are still as written. */
	root: Scope
	/** Whether the module may reach what holds the language's own methods, and so replace one. */
	patched: boolean
	/** What is left to look at before giving up. */
	budget: { left: number }
}

const ANY: Val = { kind: null }
const STRING: Val = { kind: 'string' }
const NUMBER: Val = { kind: 'number' }
const BOOLEAN: Val = { kind: 'boolean' }

function join(a: Val, b: Val): Val {
	if (a === b) return a
	const tied = growing(a) || growing(b)
	if (a.kind !== b.kind || a.kind === null) return tied ? { kind: null, tied } : ANY
	return { kind: a.kind, ...(a.of && b.of ? { of: join(a.of, b.of) } : {}), ...(tied ? { tied } : {}) }
}

const joined = (vals: Val[]): Val | undefined => (vals.length === 0 ? undefined : vals.reduce(join))

function unwrap(node: Node | null | undefined): Node | null {
	while (
		node &&
		(node.type === 'ParenthesizedExpression' ||
			node.type === 'TSAsExpression' ||
			node.type === 'TSSatisfiesExpression' ||
			node.type === 'TSNonNullExpression' ||
			node.type === 'TSTypeAssertion')
	) {
		node = node.expression
	}
	return node ?? null
}

/** What a call hands a function it is given, and what the call gives for what the function returns. */
type Takes = (self: Val) => Val[]
interface Method {
	/** The kind each argument must be, `null` for any value; `fn` for a function the method calls. */
	args: Array<Kind | 'fn'>
	/** How many of `args` must be there. */
	min: number
	takes?: Takes
	to: (self: Val, result: Val | undefined) => Val
}

const element = (self: Val): Val => (self.kind === 'string' ? STRING : (self.of ?? ANY))
const each: Takes = (self) => [element(self), NUMBER, self]
const method = (names: string, args: Method['args'], min: number, to: Method['to'], takes?: Takes): Array<[string, Method]> =>
	names.split(' ').map((name) => [name, takes ? { args, min, to, takes } : { args, min, to }])

/**
 * The methods that change nothing. Each takes what the language's own method
 * takes without throwing, and calls only the function it is given, if any.
 */
const METHODS: Partial<Record<NonNullable<Kind>, Record<string, Method>>> = {
	array: Object.fromEntries([
		...method('map', ['fn'], 1, (_, result) => ({ kind: 'array', of: result ?? ANY }), each),
		...method('filter', ['fn'], 1, (self) => ({ kind: 'array', ...(self.of ? { of: self.of } : {}) }), each),
		...method('find findLast', ['fn'], 1, () => ANY, each),
		...method('findIndex findLastIndex', ['fn'], 1, () => NUMBER, each),
		...method('some every', ['fn'], 1, () => BOOLEAN, each),
		...method('includes', [null], 1, () => BOOLEAN),
		...method('indexOf lastIndexOf', [null], 1, () => NUMBER),
		...method('slice', ['number', 'number'], 0, (self) => ({ kind: 'array', ...(self.of ? { of: self.of } : {}) })),
		...method('toReversed', [], 0, (self) => ({ kind: 'array', ...(self.of ? { of: self.of } : {}) })),
		...method('concat', ['array'], 1, () => ({ kind: 'array' })),
		...method('join', ['string'], 0, () => STRING),
		...method('at', ['number'], 1, () => ANY),
	]),
	string: Object.fromEntries([
		...method('toLowerCase toUpperCase trim trimStart trimEnd', [], 0, () => STRING),
		...method('slice substring', ['number', 'number'], 0, () => STRING),
		...method('charAt', ['number'], 1, () => STRING),
		...method('replace replaceAll', ['string', 'string'], 2, () => STRING),
		...method('concat', ['string'], 1, () => STRING),
		...method('split', ['string'], 1, () => ({ kind: 'array', of: STRING })),
		...method('startsWith endsWith includes', ['string'], 1, () => BOOLEAN),
		...method('indexOf lastIndexOf', ['string'], 1, () => NUMBER),
	]),
	set: Object.fromEntries(method('has', [null], 1, () => BOOLEAN)),
	map: Object.fromEntries([...method('has', [null], 1, () => BOOLEAN), ...method('get', [null], 1, () => ANY)]),
}

/** `Object.keys(x)`: what of the language's is called on its name, with the kinds it takes without throwing. */
const STATICS: Record<string, Record<string, { args: Array<Array<NonNullable<Kind>> | null>; to: (args: Val[]) => Val }>> = {
	Object: {
		keys: { args: [['object', 'array']], to: () => ({ kind: 'array', of: STRING }) },
		values: { args: [['object', 'array']], to: ([of]) => ({ kind: 'array', ...(of!.of ? { of: of!.of } : {}) }) },
		entries: { args: [['object', 'array']], to: () => ({ kind: 'array', of: { kind: 'array' } }) },
	},
	Array: {
		isArray: { args: [null], to: () => BOOLEAN },
		from: { args: [['array', 'set', 'string']], to: ([of]) => ({ kind: 'array', of: element(of!) }) },
	},
	Math: Object.fromEntries(
		'abs ceil floor round trunc sign sqrt'.split(' ').map((name) => [name, { args: [['number']], to: () => NUMBER }]),
	),
}
/** Called by name, these turn a value of literals into another with the language's own code. */
const CALLED: Record<string, Val> = { String: STRING, Number: NUMBER, Boolean: BOOLEAN }

interface Run {
	mod: Module
	/** The functions being looked at: one that calls itself is refused. */
	stack: Set<Node>
}

/**
 * What evaluating `node` gives, if it runs only the language's own code and
 * the module's functions that do the same, and gives a value with no code of
 * the module's on it. `undefined` when that cannot be told.
 */
export function value(node: Node | null | undefined, scope: Scope, mod: Module): Val | undefined {
	return mod.patched ? undefined : evaluate(node, scope, { mod, stack: new Set() })
}

/** Whether `name` is the language's where it is read. */
function native(name: string, scope: Scope, run: Run): boolean {
	return !scope.holder(name) && !run.mod.own(name) && !run.mod.taken(name)
}

function evaluate(node: Node | null | undefined, scope: Scope, run: Run): Val | undefined {
	node = unwrap(node)
	if (!node || --run.mod.budget.left < 0) return undefined
	const all = (nodes: Array<Node | null>): Val[] | undefined => {
		const vals: Val[] = []
		for (const child of nodes) {
			const val = evaluate(child, scope, run)
			if (!val) return undefined
			vals.push(val)
		}
		return vals
	}
	switch (node.type) {
		case 'Literal': {
			const type = typeof node.value
			// A big number throws where it meets another kind.
			if (type === 'bigint' || node.bigint !== undefined) return undefined
			return type === 'string' ? STRING : type === 'number' ? NUMBER : type === 'boolean' ? BOOLEAN : ANY
		}
		case 'TemplateLiteral':
			return all(node.expressions) && STRING
		case 'Identifier': {
			const val = scope.get(node.name)
			if (val) return val
			if (scope.holder(node.name) || run.mod.own(node.name)) return undefined
			if (run.mod.taken(node.name)) return undefined
			return node.name === 'undefined' ? ANY : node.name === 'NaN' || node.name === 'Infinity' ? NUMBER : undefined
		}
		case 'ArrayExpression': {
			const vals: Val[] = []
			for (const item of node.elements as Array<Node | null>) {
				if (!item) return undefined
				const val = evaluate(item.type === 'SpreadElement' ? item.argument : item, scope, run)
				if (!val) return undefined
				if (item.type !== 'SpreadElement') vals.push(val)
				else if (val.kind === 'array' || val.kind === 'set' || val.kind === 'string') vals.push(element(val))
				else return undefined
			}
			const of = joined(vals)
			return of ? { kind: 'array', of } : { kind: 'array' }
		}
		case 'ObjectExpression': {
			const fields = new Map<string, Val>()
			let open = false
			for (const property of node.properties as Node[]) {
				if (property.type === 'SpreadElement') {
					if (!evaluate(property.argument, scope, run)) return undefined
					open = true
					continue
				}
				if (property.kind !== 'init' || property.method || property.computed) return undefined
				const key = property.key.type === 'Identifier' ? property.key.name : String(property.key.value)
				// The key that sets what an object inherits from, and those the language calls to turn it into a string or a number.
				if (key === '__proto__' || key === 'toString' || key === 'valueOf') return undefined
				const val = evaluate(property.value, scope, run)
				if (!val) return undefined
				fields.set(key, val)
			}
			if (open) return { kind: 'object' }
			const of = joined([...fields.values()])
			return of ? { kind: 'object', of, fields } : { kind: 'object', fields }
		}
		case 'ChainExpression':
			return evaluate(node.expression, scope, run)
		case 'MemberExpression': {
			const object = evaluate(node.object, scope, run)
			if (!object) return undefined
			// Of `null` or `undefined` the read throws, unless it is written not to.
			if (object.kind === null) return node.optional ? ANY : undefined
			if (node.computed) {
				const key = evaluate(node.property, scope, run)
				return key && (key.kind === 'string' || key.kind === 'number') ? ANY : undefined
			}
			const name = node.property.name as string
			if (name === 'length' && (object.kind === 'array' || object.kind === 'string')) return NUMBER
			if (name === 'size' && (object.kind === 'set' || object.kind === 'map')) return NUMBER
			return (object.kind === 'object' && object.fields?.get(name)) || ANY
		}
		case 'UnaryExpression': {
			if (node.operator === 'delete' || !evaluate(node.argument, scope, run)) return undefined
			return node.operator === '!' ? BOOLEAN : node.operator === 'typeof' ? STRING : node.operator === 'void' ? ANY : NUMBER
		}
		case 'BinaryExpression': {
			const sides = all([node.left, node.right])
			if (!sides) return undefined
			const [left, right] = sides as [Val, Val]
			const operator = node.operator as string
			if (operator === 'instanceof') return undefined
			if (operator === 'in') return right.kind === 'object' || right.kind === 'array' ? BOOLEAN : undefined
			if (/^[=!<>]/.test(operator) && operator !== '<<' && operator !== '>>' && operator !== '>>>') return BOOLEAN
			if (operator !== '+') return NUMBER
			if (left.kind === 'string' || right.kind === 'string') return STRING
			return left.kind === 'number' && right.kind === 'number' ? NUMBER : ANY
		}
		case 'LogicalExpression': {
			const sides = all([node.left, node.right])
			return sides && join(sides[0]!, sides[1]!)
		}
		case 'ConditionalExpression': {
			const parts = all([node.test, node.consequent, node.alternate])
			return parts && join(parts[1]!, parts[2]!)
		}
		case 'NewExpression': {
			const made = unwrap(node.callee)
			if (made?.type !== 'Identifier' || (made.name !== 'Set' && made.name !== 'Map')) return undefined
			if (!native(made.name, scope, run) || node.arguments.length > 1) return undefined
			if (node.arguments.length === 0) return { kind: made.name === 'Set' ? 'set' : 'map' }
			const from = evaluate(node.arguments[0], scope, run)
			if (!from) return undefined
			if (made.name === 'Set') {
				return from.kind === 'array' || from.kind === 'set' || from.kind === 'string' ? { kind: 'set', of: element(from) } : undefined
			}
			// A `Map` reads a key and a value off each of what it is made of.
			return from.kind === 'array' && from.of?.kind === 'array' ? { kind: 'map' } : undefined
		}
		case 'CallExpression':
			return called(node, scope, run)
		default:
			return undefined
	}
}

function called(node: Node, scope: Scope, run: Run): Val | undefined {
	const callee = unwrap(node.callee)
	const args = node.arguments as Node[]
	if (!callee || node.optional || args.some((arg) => arg.type === 'SpreadElement')) return undefined
	const values = (): Val[] | undefined => {
		const vals: Val[] = []
		for (const arg of args) {
			const val = evaluate(arg, scope, run)
			if (!val) return undefined
			vals.push(val)
		}
		return vals
	}
	if (callee.type === 'Identifier') {
		const name = callee.name as string
		if (Object.hasOwn(CALLED, name) && native(name, scope, run)) {
			return args.length === 1 && values() ? CALLED[name] : undefined
		}
		// A function of the module's, where no variable hides its name.
		const fn = scope.holder(name) ? undefined : run.mod.fns.get(name)
		const vals = fn && values()
		return fn && vals ? apply(fn, vals, run.mod.root, run) : undefined
	}
	if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || callee.property.type !== 'Identifier') {
		return undefined
	}
	const name = callee.property.name as string
	const object = unwrap(callee.object)
	if (object?.type === 'Identifier' && Object.hasOwn(STATICS, object.name) && !scope.get(object.name)) {
		if (!native(object.name, scope, run) || !Object.hasOwn(STATICS[object.name]!, name)) return undefined
		const spec = STATICS[object.name]![name]!
		const vals = args.length === spec.args.length ? values() : undefined
		if (!vals || !vals.every((val, index) => spec.args[index] === null || spec.args[index]!.includes(val.kind as never))) {
			return undefined
		}
		return spec.to(vals)
	}
	const self = evaluate(object, scope, run)
	// Adding to an array the function made itself changes nothing that was there before it ran.
	if (name === 'push' && self?.own && object?.type === 'Identifier') {
		const vals = values()
		// Not what holds the array: it would then hold itself.
		return vals && !vals.some(growing) ? NUMBER : undefined
	}
	const methods = self?.kind ? METHODS[self.kind] : undefined
	if (!self || !methods || !Object.hasOwn(methods, name)) return undefined
	const spec = methods[name]!
	if (args.length < spec.min || args.length > spec.args.length) return undefined
	let result: Val | undefined
	for (const [index, arg] of args.entries()) {
		const kind = spec.args[index]!
		if (kind === 'fn') {
			result = handed(arg, spec.takes!(self), scope, run)
			if (!result) return undefined
			continue
		}
		const val = evaluate(arg, scope, run)
		if (!val || (kind !== null && val.kind !== kind)) return undefined
	}
	return spec.to(self, result)
}

/** What a function written in a call, or named there, gives when the call hands it `vals`. */
function handed(arg: Node, vals: Val[], scope: Scope, run: Run): Val | undefined {
	const fn = unwrap(arg)
	if (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') return apply(fn, vals, scope, run)
	if (fn?.type !== 'Identifier' || scope.holder(fn.name)) return undefined
	const named = run.mod.fns.get(fn.name)
	return named && apply(named, vals, run.mod.root, run)
}

/** Whether `node` reads what belongs to a call rather than to the code: `this`, `arguments`, `super`, `new.target`. */
function bound(node: Node | null | undefined): boolean {
	if (!node || typeof node !== 'object') return false
	if (Array.isArray(node)) return node.some(bound)
	if (typeof node.type !== 'string') return false
	if (node.type === 'ThisExpression' || node.type === 'Super' || node.type === 'MetaProperty') return true
	if (node.type === 'Identifier') return node.name === 'arguments'
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end') continue
		const child = node[key]
		if (child && typeof child === 'object' && bound(child)) return true
	}
	return false
}

/** The variables `node` assigns to. */
function assigned(node: Node | null | undefined, names: Set<string>): Set<string> {
	if (!node || typeof node !== 'object') return names
	if (Array.isArray(node)) {
		for (const child of node) assigned(child, names)
		return names
	}
	if (typeof node.type !== 'string') return names
	const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : null
	if (target?.type === 'Identifier') names.add(target.name)
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end') continue
		const child = node[key]
		if (child && typeof child === 'object') assigned(child, names)
	}
	return names
}

/** The variables `node` calls `push` on. */
function pushed(node: Node | null | undefined, names: Set<string>): Set<string> {
	if (!node || typeof node !== 'object') return names
	if (Array.isArray(node)) {
		for (const child of node) pushed(child, names)
		return names
	}
	if (typeof node.type !== 'string') return names
	if (node.type === 'MemberExpression' && !node.computed && node.property.name === 'push' && node.object.type === 'Identifier') {
		names.add(node.object.name)
	}
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end') continue
		const child = node[key]
		if (child && typeof child === 'object') pushed(child, names)
	}
	return names
}

interface Frame {
	run: Run
	/** The scope of the function's own variables: an assignment may reach no further out. */
	top: Scope
	/** Its variables that are assigned to, which may then hold any value of literals. */
	loose: Set<string>
	/** Its variables that are added to with `push`. */
	grown: Set<string>
	returned: Val | undefined
}

/** What `fn` gives when called with `vals`, if all it runs is as `evaluate` tells. */
function apply(fn: Node, vals: Val[], closure: Scope, run: Run): Val | undefined {
	if (fn.async || fn.generator || !fn.body || run.stack.has(fn) || bound(fn.params) || bound(fn.body)) return undefined
	const top = new Scope(closure)
	const frame: Frame = {
		run,
		top,
		loose: assigned(fn.body, assigned(fn.params, new Set())),
		grown: pushed(fn.body, new Set()),
		returned: undefined,
	}
	run.stack.add(fn)
	try {
		for (const [index, param] of (fn.params as Node[]).entries()) {
			if (!declare(param, vals[index] ?? ANY, top, frame)) return undefined
		}
		if (fn.body.type !== 'BlockStatement') return evaluate(fn.body, top, run)
		const body = fn.body.body as Node[]
		const inner = new Scope(top)
		for (const statement of body) if (!execute(statement, inner, frame)) return undefined
		// Past its last statement a function gives `undefined`.
		return body.at(-1)?.type === 'ReturnStatement' && frame.returned ? frame.returned : ANY
	} finally {
		run.stack.delete(fn)
	}
}

/** Whether nothing the function can read is called `name` yet, but for a parameter hiding a name from outside it. */
function fresh(name: string, scope: Scope, frame: Frame): boolean {
	if (scope === frame.top) return scope.holder(name) !== scope
	return !scope.holder(name) && !frame.run.mod.own(name)
}

/** Declares the names of `pattern` for `val`, which it must be able to take apart without throwing. */
function declare(pattern: Node, val: Val, scope: Scope, frame: Frame, fixed = false): boolean {
	switch (pattern.type) {
		case 'Identifier':
			// Assigning to a `const` throws.
			if (fixed && frame.loose.has(pattern.name)) return false
			// A name that hides another reads as the other before it is declared, where reading it throws.
			if (!fresh(pattern.name, scope, frame)) return false
			scope.set(pattern.name, frame.loose.has(pattern.name) ? ANY : val)
			return true
		case 'AssignmentPattern': {
			// Only a literal: anything else may read a name that is not declared yet.
			const initial = unwrap(pattern.right)?.type === 'Literal' ? evaluate(pattern.right, scope, frame.run) : undefined
			return initial !== undefined && declare(pattern.left, join(val, initial), scope, frame, fixed)
		}
		case 'ArrayPattern':
			if (val.kind !== 'array' && val.kind !== 'string') return false
			return (pattern.elements as Array<Node | null>).every(
				(item) => item === null || (item.type !== 'RestElement' && declare(item, ANY, scope, frame, fixed)),
			)
		case 'ObjectPattern':
			if (val.kind === null) return false
			return (pattern.properties as Node[]).every(
				(property) => property.type === 'Property' && !property.computed && declare(property.value, ANY, scope, frame, fixed),
			)
		default:
			return false
	}
}

/** An assignment to a variable of the function, as a statement: `a = b`, `a += b`, `a++`. */
function assigns(node: Node, scope: Scope, frame: Frame): boolean {
	const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : null
	if (target?.type !== 'Identifier') return false
	// Not one of an enclosing function, or of the module.
	const holder = scope.holder(target.name)
	let at: Scope | undefined = scope
	while (at && at !== holder) at = at === frame.top ? undefined : at.parent
	if (!holder || !at) return false
	// `a += b` and `a++` read what `a` holds, which may be a big number or nothing the operator takes.
	return node.type === 'AssignmentExpression' && node.operator === '=' && evaluate(node.right, scope, frame.run) !== undefined
}

function execute(node: Node, scope: Scope, frame: Frame): boolean {
	const { run } = frame
	if (--run.mod.budget.left < 0) return false
	switch (node.type) {
		case 'EmptyStatement':
			return true
		case 'VariableDeclaration':
			if (node.kind !== 'const' && node.kind !== 'let') return false
			return (node.declarations as Node[]).every((declarator) => {
				let val = declarator.init ? evaluate(declarator.init, scope, run) : ANY
				// An array written here and added to: what it holds is told by no one.
				if (
					val &&
					node.kind === 'const' &&
					declarator.id.type === 'Identifier' &&
					frame.grown.has(declarator.id.name) &&
					unwrap(declarator.init)?.type === 'ArrayExpression' &&
					!growing(val)
				) {
					val = { kind: 'array', own: true }
				}
				return val !== undefined && declare(declarator.id, val, scope, frame, node.kind === 'const')
			})
		case 'ExpressionStatement': {
			const expression = unwrap(node.expression)
			if (!expression) return false
			return assigns(expression, scope, frame) || evaluate(expression, scope, run) !== undefined
		}
		case 'ReturnStatement': {
			const val = node.argument ? evaluate(node.argument, scope, run) : ANY
			if (!val) return false
			frame.returned = frame.returned ? join(frame.returned, val) : val
			return true
		}
		case 'BlockStatement': {
			const inner = new Scope(scope)
			return (node.body as Node[]).every((statement) => execute(statement, inner, frame))
		}
		case 'IfStatement':
			return (
				evaluate(node.test, scope, run) !== undefined &&
				execute(node.consequent, new Scope(scope), frame) &&
				(!node.alternate || execute(node.alternate, new Scope(scope), frame))
			)
		case 'ForOfStatement': {
			const from = evaluate(node.right, scope, run)
			// One that is added to as it is gone through may never end.
			if (node.await || !from || growing(from) || (from.kind !== 'array' && from.kind !== 'set' && from.kind !== 'string')) return false
			const left = node.left as Node
			if (left.type !== 'VariableDeclaration' || left.kind === 'var' || left.declarations.length !== 1) return false
			const inner = new Scope(scope)
			return declare(left.declarations[0].id, element(from), inner, frame, left.kind === 'const') && execute(node.body, new Scope(inner), frame)
		}
		default:
			return false
	}
}
