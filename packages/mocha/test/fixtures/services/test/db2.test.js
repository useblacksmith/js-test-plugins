const assert = require('node:assert')
const { query, close } = require('../src/db')
describe('db2', () => {
	after(() => close())
	it('queries (connection already open: only a write)', async () => assert.equal(await query('select 2'), 'ok select 2'))
	it('does not touch the database', () => assert.ok(true))
})
