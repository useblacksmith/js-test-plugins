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
}

/** A value import: the module specifier and the names taken from it, `'*'` for all of them. */
export type Import = [specifier: string, names: string[] | '*']

export interface Digest {
	rest: string
	restRefs: string[]
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
	/** Every specifier the module loads statically, in order. */
	sources: string[]
	/** The module may take any name from a module the analysis cannot name. */
	wild: boolean
}

export interface Analysis {
	digest: Digest
	/** Insertions that make each `f` unit report its first statement running: offset, text. */
	marks: Array<[number, string]>
}

type Node = { type: string; start: number; end: number; [key: string]: any }

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
 * already using the instrumentation's names.
 */
export function analyze(code: string, file: string): Analysis | null {
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

	/** Collects the identifiers `node` mentions as values into `ids`. */
	const walk = (node: unknown, ids: Set<string>): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child, ids)
			return
		}
		if (!node || typeof node !== 'object') return
		const n = node as Node
		if (typeof n.type !== 'string') return
		if (
			(n.type.startsWith('TS') && !VALUE_TS.has(n.type)) ||
			n.declare === true ||
			n.importKind === 'type' ||
			n.exportKind === 'type'
		) {
			if (n.type === 'TSExportAssignment' || n.type === 'TSImportEqualsDeclaration') {
				opaque = true
			}
			holes.push([n.start, n.end])
			return
		}
		switch (n.type) {
			case 'Identifier':
			case 'JSXIdentifier':
				ids.add(n.name)
				if (n.name === 'eval') opaque = true
				break
			case 'MemberExpression':
				if (
					(n.object.type === 'Identifier' &&
						n.object.name === 'module' &&
						n.property.name === 'exports') ||
					(n.object.type === 'Identifier' && n.object.name === 'exports')
				) {
					opaque = true
				}
				if (
					n.object.type === 'MetaProperty' &&
					typeof n.property.name === 'string' &&
					n.property.name.startsWith('glob')
				) {
					wild = true
				}
				break
			case 'ImportExpression': {
				const source = literal(n.source)
				if (source === null) wild = true
				else loaded.push([source, '*'])
				break
			}
			case 'CallExpression': {
				const callee = unwrap(n.callee)
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
					else loaded.push([source, '*'])
				}
				break
			}
		}
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
		ids: Set<string>
	}
	const drafts: Draft[] = []
	const rest: Array<{ start: number; end: number } | string> = []
	const restIds = new Set<string>()
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
		const call = `${HIT}(${JSON.stringify(name)})`
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

	const unit = (name: string, node: Node, value: Node | null, prefix: string): void => {
		const ids = new Set<string>()
		walk(node, ids)
		const fn = unwrap(value)
		if (isFunction(fn) && fn.body) {
			drafts.push({ name, kind: 'f', start: node.start, split: fn.body.start, end: node.end, prefix, ids })
			mark(name, fn)
		} else {
			drafts.push({ name, kind: 'v', start: node.start, split: node.start, end: node.end, prefix, ids })
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
				if (node.source && node.exportKind !== 'type') linked.push(node.source.value)
				for (const specifier of node.specifiers as Node[]) {
					if (specifier.exportKind === 'type') continue
					const local: string = specifier.local.name ?? specifier.local.value
					const name: string = specifier.exported.name ?? specifier.exported.value
					if (node.source) reexports[name] = [node.source.value, local]
					else exports[name] = local
				}
				if (node.source) rest.push(`export from ${node.source.value}`)
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
	if (opaque) return null
	const names = new Set<string>()
	for (const draft of drafts) {
		// Two declarations of one name (`var` twice, a function redeclared).
		if (names.has(draft.name) && draft.kind === 'f') return null
		names.add(draft.name)
	}

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
	const used = new Set(restIds)
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
	for (const [source] of loaded) sources.push(source)

	const refsOf = (ids: Set<string>, self: string | null): string[] =>
		[...ids].filter((id) => id !== self && (names.has(id) || bindings.has(id))).sort()
	const resolved = (refs: string[]): string =>
		refs.map((ref) => `${ref}=${bindings.get(ref) ?? ''}`).join('\n')

	// A value nothing exports or mentions is there for what evaluating it
	// does, like any other top-level statement.
	const mentioned = new Set(restIds)
	for (const draft of drafts) {
		for (const id of draft.ids) if (id !== draft.name) mentioned.add(id)
	}
	const exportedLocals = new Set(Object.values(exports))
	const units: Record<string, Unit> = {}
	const restParts: string[] = []
	for (const part of rest) {
		restParts.push(typeof part === 'string' ? part : text(part.start, part.end))
	}
	for (const draft of drafts) {
		const refs = refsOf(draft.ids, draft.name)
		if (draft.kind === 'v' && !exportedLocals.has(draft.name) && !mentioned.has(draft.name)) {
			restParts.push(draft.prefix + text(draft.start, draft.end))
			for (const id of draft.ids) restIds.add(id)
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
		// One destructuring declares several names; a repeated `var` keeps both texts.
		units[draft.name] = previous
			? {
					kind: 'v',
					sig: hash(previous.sig + next.sig),
					body: hash(previous.body + next.body),
					refs: [...new Set([...previous.refs, ...refs])].sort(),
				}
			: next
	}
	const restRefs = refsOf(restIds, null)
	return {
		digest: {
			rest: hash(`${restParts.join('\n')}\n${resolved(restRefs)}`),
			restRefs,
			units,
			exports,
			reexports,
			stars,
			imports,
			sources: [...new Set(sources)],
			wild,
		},
		marks,
	}
}

/** `code` with every top-level function reporting to `HITS[key]` when it is entered. */
export function footer(key: string): string {
	return `\n;function ${HIT}(n){(${HIT}.t??=((globalThis.${HITS}??={})[${JSON.stringify(key)}]??={}))[n]=1}${HIT}(${JSON.stringify(LOADED)});`
}
