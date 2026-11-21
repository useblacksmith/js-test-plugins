import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { HIT } from '../../core/src/hits.ts'
import { resolveDigest } from '../../core/src/narrow.ts'
import { isPackagePath } from '../../core/src/packages.ts'
import { analyze, globalFooter } from '../../core/src/units.ts'
import type { Digester } from '../../core/src/unitstore.ts'

/** `0` keeps a change to a file rerunning every test that loaded it, whichever functions the test entered. */
export const ENV_NARROW = 'BLACKSMITH_MOCHA_NARROW'
/** What a marked module reports before anything else in it runs: until it reports `LOADED`, what is entered is entered by its load. */
export const STARTED = ' started'

/**
 * Whether modules are marked. Not under coverage (nyc, c8, `NODE_V8_COVERAGE`):
 * the marks are code the report would count, at offsets the source does not have.
 */
export function narrows(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[ENV_NARROW] === '0') return false
	return !env.NODE_V8_COVERAGE && !env.NYC_CONFIG && !env.NYC_PROCESS_ID
}

/** `absolute` as the record names it; null outside the repository or in an installed package. */
export function sourceFile(repo: string, absolute: string): string | null {
	const relative = path.relative(repo, absolute).split(path.sep).join('/')
	if (relative === '' || relative.startsWith('../') || path.isAbsolute(relative)) return null
	return isPackagePath(relative) ? null : relative
}

/**
 * `code` with every top-level function reporting when it is entered, on the
 * lines it had; null for a module that cannot be narrowed (CommonJS, not
 * JavaScript or TypeScript, unparsable).
 */
export function mark(code: string, filename: string, key: string): string | null {
	const analysis = analyze(code, filename, key)
	if (!analysis) return null
	const call = (name: string) => `globalThis.${HIT}?.(${JSON.stringify(key)},${JSON.stringify(name)});`
	// After a `#!` line, which has to stay the first.
	const start = code.startsWith('#!') ? code.indexOf('\n') + 1 || code.length : 0
	const marks: Array<[number, string]> = [[start, call(STARTED)], ...analysis.marks]
	let out = ''
	let from = 0
	// `sort` is stable: two marks at one offset stay in the order they were given.
	for (const [at, text] of marks.sort((a, b) => a[0] - b[0])) {
		out += code.slice(from, at) + text
		from = at
	}
	return out + code.slice(from) + globalFooter(key)
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/** Where `specifier` leads from `importer`: Node's answer, or for a relative one the source file a TypeScript loader would take (`./a.js` for `a.ts`). */
function resolve(require: NodeJS.Require, importer: string, specifier: string): string | null {
	try {
		return require.resolve(specifier)
	} catch {}
	if (!specifier.startsWith('.')) return null
	const base = path.resolve(path.dirname(importer), specifier)
	for (const stem of [base, base.replace(/\.[cm]?jsx?$/, ''), path.join(base, 'index')]) {
		for (const extension of EXTENSIONS) {
			if (existsSync(stem + extension)) return stem + extension
		}
	}
	return null
}

/** Digests of the repository's modules as they are on disk, with what each loads resolved the way Node resolves it from there. */
export function digester(repo: string): Digester {
	return {
		digest(module, code) {
			const absolute = path.join(repo, module)
			// A CommonJS module too: what it loads says which changes can reach a test through it.
			const analysis = analyze(code, absolute, undefined, true)
			if (!analysis) return null
			const require = createRequire(absolute)
			const specifiers: Record<string, string> = {}
			for (const specifier of new Set(analysis.digest.sources)) {
				const target = resolve(require, absolute, specifier)
				if (target === null) continue
				const inRepo = path.isAbsolute(target) ? sourceFile(repo, target) : null
				if (inRepo !== null) specifiers[specifier] = inRepo
			}
			return resolveDigest(analysis.digest, specifiers)
		},
	}
}
