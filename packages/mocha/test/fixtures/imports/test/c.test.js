const assert = require('node:assert')
const { loadLazy } = require('../src/helper')
describe('c (cjs, lazy require in a test)', () => { it('loads lazily', () => assert.equal(loadLazy(), 42)) })
