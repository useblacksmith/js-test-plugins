import { beta } from '../src/beta.js'

test('reads another key', () => {
	expect(typeof beta()).toBe('string')
})
