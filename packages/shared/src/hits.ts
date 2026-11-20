/** The function every instrumented module calls on entering a function. */
export const HIT = '__blacksmith_hit__'
/** On `globalThis` of whatever realm runs the tests: file → names of the functions entered. */
export const HITS = '__BLACKSMITH_UNITS__'
/** The entry a module leaves when it finished loading, whatever ran in it. */
export const LOADED = ''

type Table = Record<string, Record<string, 1>>

/** Leaves the function the marks of `analyze(code, file, key)` call on `globalThis`, once. */
export function installHit(): void {
	const realm = globalThis as unknown as Record<string, unknown>
	if (typeof realm[HIT] === 'function') return
	let last: string | undefined
	let entered: Record<string, 1> = {}
	realm[HIT] = (key: string, name: string): void => {
		if (key !== last) {
			const table = (realm[HITS] ??= {}) as Table
			entered = table[key] ??= {}
			last = key
		}
		entered[name] = 1
	}
}
