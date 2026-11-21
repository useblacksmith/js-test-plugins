import { count } from '../src/names.js'

test('reads a value built from every key', () => {
	expect(count()).toBeGreaterThan(1)
})
