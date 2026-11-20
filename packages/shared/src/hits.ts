/** The function every instrumented module calls on entering a function. */
export const HIT = '__blacksmith_hit__'
/** On `globalThis` of whatever realm runs the tests: file → names of the functions entered. */
export const HITS = '__BLACKSMITH_UNITS__'
/** The entry a module leaves when it finished loading, whatever ran in it. */
export const LOADED = ''
