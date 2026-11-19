import assert from 'node:assert'
describe('z (esm, dynamic import in a test)', () => {
	it('imports', async () => assert.equal((await import('../src/esm/dyn.mjs')).dyn, 'dyn-dep'))
})
