const assert = require('node:assert')
const { b } = require('../src/b')
describe('b (cjs, shared already cached)', () => { it('loads', () => assert.equal(b, 'shared')) })
