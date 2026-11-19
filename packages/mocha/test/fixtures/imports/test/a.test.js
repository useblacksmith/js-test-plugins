const assert = require('node:assert')
const { a } = require('../src/a')
describe('a (cjs)', () => { it('loads', () => assert.equal(a, 'shared')) })
