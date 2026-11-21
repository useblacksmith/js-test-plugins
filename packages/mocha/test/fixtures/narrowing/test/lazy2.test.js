import assert from 'node:assert'

describe('lazy', () => {
	it('uses what the module made when it loaded', async () => {
		const { AT_LOAD } = await import('../src/lazy.js')
		assert.equal(AT_LOAD, 'ready')
	})
})
