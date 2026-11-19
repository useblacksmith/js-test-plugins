import assert from 'node:assert'
import value from '../src/esm-loadtime.mjs'
describe('d (esm, module already evaluated)', () => { it('uses a value an ES module read at load time', () => assert.equal(value.name, 'esm-loadtime')) })
