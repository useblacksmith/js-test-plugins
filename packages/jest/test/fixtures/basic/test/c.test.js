const c = require('../src/c')

test('c one', () => {
	expect(c).toBe(3)
})

test('c two', () => {
	expect(c + 1).toBe(4)
})
