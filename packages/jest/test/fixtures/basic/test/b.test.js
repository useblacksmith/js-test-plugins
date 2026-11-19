test('b', () => {
	expect(require('../src/b')).toBe(1)
	expect(process.env.FIXTURE_PORT).toBe('4000')
})
