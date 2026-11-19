const assert = require('node:assert')
const { loadLazy } = require('../src/helper')
describe('d (cjs, same lazy require, cached by c)', () => { it('loads lazily', () => assert.equal(loadLazy(), 42)) })
