import assert from 'node:assert'
describe('w (esm, same dynamic import, cached by z)', () => {
	it('imports', async () => assert.equal((await import('../src/esm/dyn.mjs')).dyn, 'dyn-dep'))
})
