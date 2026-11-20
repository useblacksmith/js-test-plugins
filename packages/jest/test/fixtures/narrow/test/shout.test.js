import { shout } from '../src/index.js'

test('shouts', () => {
	expect(shout('a')).toBe('A')
})
