import { isAlpha } from '../src/flags.js'

test('enters a function of the module that reads one key', () => {
	expect(isAlpha('alpha')).toBe(true)
})
