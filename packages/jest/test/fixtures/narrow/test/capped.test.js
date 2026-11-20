import { capped } from '../src/math.js'

test('caps', () => {
	expect(capped(50)).toBe(10)
})

test('leaves small numbers', () => {
	expect(capped(5)).toBe(5)
})
