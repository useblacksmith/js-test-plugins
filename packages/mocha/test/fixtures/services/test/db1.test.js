const assert = require('node:assert')
const { query } = require('../src/db')
describe('db1', () => { it('queries (opens the pooled connection)', async () => assert.equal(await query('select 1'), 'ok select 1')) })
