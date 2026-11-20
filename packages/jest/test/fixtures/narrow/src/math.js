import { LIMIT } from './limits.js'

export function add(a, b) {
	return a + b
}

export const double = (n) => n * 2

export function capped(n) {
	return Math.min(n, LIMIT)
}
