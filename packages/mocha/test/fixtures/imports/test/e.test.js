const assert = require('node:assert')
// require(esm): a CommonJS spec loading an ES module.
const { x } = require('../src/esm/x.mjs')
describe('e (cjs spec requiring esm)', () => { it('loads', () => assert.equal(x, 'esm-shared')) })
