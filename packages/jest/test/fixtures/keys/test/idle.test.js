import { flag } from '../src/any.js'

test('loads what reads any key, and never calls it', () => {
	expect(typeof flag).toBe('function')
})
