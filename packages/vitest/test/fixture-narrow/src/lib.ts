import { helper } from './helper.ts'

export interface Shape {
	size: number
}

export const LIMIT = 5
export const UNUSED = 'unused'
export const DERIVED = LIMIT * 2

export function called(n: number): number {
	return helper(n) + 1
}

export const arrow = (n: number): number => n * 2

export function reads(): number {
	return LIMIT
}

export class Box {
	size(): number {
		return 1
	}
}
