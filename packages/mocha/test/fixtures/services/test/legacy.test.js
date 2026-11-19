const assert = require('node:assert')
// Depends on something no tracker sees at all (say, a container image built from docker/).
describe('legacy', () => { it('passes', () => assert.ok(true)) })
