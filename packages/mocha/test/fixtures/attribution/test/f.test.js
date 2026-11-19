const assert = require('node:assert')
const loadtime = require('../src/loadtime')
describe('f', () => { it('uses a value read at load time', () => assert.equal(loadtime.name, 'loadtime')) })
