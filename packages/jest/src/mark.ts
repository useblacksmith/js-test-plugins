import { createHash } from 'node:crypto'
import path from 'node:path'

import { analyze, footer } from '../../shared/src/units.ts'

/**
 * Runs in every process that runs test files. Wraps the project's
 * transformers so that a repository module reaches them with every top-level
 * function reporting when a test enters it. Jest caches what a transformer
 * returns, so a module is marked once and not again until it changes.
 */
const SALT = 'blacksmith-narrow-3'

/** The repository-relative path of a module the repository holds as a plain file. */
export function sourceFile(repo: string, file: string): string | null {
	if (!path.isAbsolute(file) || file.includes(`${path.sep}node_modules${path.sep}`)) return null
	const inRepo = path.relative(repo, file)
	if (inRepo.startsWith('..') || path.isAbsolute(inRepo)) return null
	return inRepo.split(path.sep).join('/')
}

/** `source` with its marks, or as it is when the module cannot be told apart by function. */
export function marked(repo: string, source: string, filename: string): string {
	const file = sourceFile(repo, filename)
	if (file === null) return source
	// Jest finds an inline snapshot by the column of the call that takes it.
	if (source.includes('InlineSnapshot')) return source
	// The marks reach the global object through `Function`, which a module may bind to something else.
	if (/\bFunction\b/.test(source)) return source
	const analysis = analyze(source, filename)
	if (!analysis) return source
	const marks = analysis.marks
		.map((mark, index) => [...mark, index] as const)
		.sort((a, b) => a[0] - b[0] || a[2] - b[2])
	let output = ''
	let at = 0
	for (const [offset, text] of marks) {
		output += source.slice(at, offset) + text
		at = offset
	}
	return output + source.slice(at) + footer(file, true)
}

interface TransformOptions {
	configString?: string
	instrument?: boolean
	transformerConfig?: unknown
	[key: string]: unknown
}

interface Transformer {
	canInstrument?: boolean
	process?: (source: string, filename: string, options: TransformOptions) => unknown
	processAsync?: (source: string, filename: string, options: TransformOptions) => unknown
	getCacheKey?: (source: string, filename: string, options: TransformOptions) => string
	getCacheKeyAsync?: (
		source: string,
		filename: string,
		options: TransformOptions,
	) => Promise<string>
}

const salted = (key: string): string =>
	createHash('sha1').update(SALT).update('\0').update(key).digest('hex')

/** What Jest keys a result by when the transformer leaves it to Jest. */
function ownKey(source: string, filename: string, options: TransformOptions): string {
	const flags = Object.entries(options)
		.filter(([, value]) => typeof value === 'boolean')
		.map(([name, value]) => `${name}=${value}`)
		.sort()
	return [
		source,
		filename,
		options.configString ?? '',
		JSON.stringify(options.transformerConfig ?? null),
		flags.join(','),
		process.version,
	].join('\0')
}

const wrappers = new WeakMap<Transformer, Transformer>()

function wrap(inner: Transformer, repo: string): Transformer {
	const known = wrappers.get(inner)
	if (known) return known
	const wrapper: Transformer = {
		// A cache entry made without the marks must not be taken for one with them.
		getCacheKey: (source, filename, options) =>
			salted(inner.getCacheKey?.(source, filename, options) ?? ownKey(source, filename, options)),
	}
	if (inner.canInstrument !== undefined) wrapper.canInstrument = inner.canInstrument
	if (inner.process) {
		wrapper.process = (source, filename, options) =>
			inner.process?.(marked(repo, source, filename), filename, options)
	}
	if (inner.processAsync) {
		wrapper.processAsync = (source, filename, options) =>
			inner.processAsync?.(marked(repo, source, filename), filename, options)
	}
	if (inner.getCacheKeyAsync) {
		wrapper.getCacheKeyAsync = async (source, filename, options) =>
			salted((await inner.getCacheKeyAsync?.(source, filename, options)) ?? '')
	}
	wrappers.set(inner, wrapper)
	wrappers.set(wrapper, wrapper)
	return wrapper
}

/**
 * Puts the marks in front of every transformer `scriptTransformer` has
 * loaded. `false` when it does not keep them the way Jest 29 and 30 do: no
 * module is marked then, and a change reruns every test file that loaded it.
 */
export function markTransforms(scriptTransformer: unknown, repo: string): boolean {
	const loaded = (scriptTransformer as { _transformCache?: unknown } | undefined)
		?._transformCache
	if (!(loaded instanceof Map)) return false
	for (const entry of loaded.values() as Iterable<{ transformer?: Transformer }>) {
		if (entry?.transformer) entry.transformer = wrap(entry.transformer, repo)
	}
	return true
}
