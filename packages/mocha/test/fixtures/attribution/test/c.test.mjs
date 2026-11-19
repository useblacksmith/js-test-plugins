import assert from 'node:assert'
import value from '../src/esm-loadtime.mjs'
describe('c (esm)', () => { it('uses a value an ES module read at load time', () => assert.equal(value.name, 'esm-loadtime')) })
