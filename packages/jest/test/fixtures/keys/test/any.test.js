import { flag } from '../src/any.js'

test('reads a key it is given', () => {
	expect(flag('ALPHA')).toBe('alpha')
})
