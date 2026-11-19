const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const mod = require('../src/c')
describe('c', () => {
	it('first', () => assert.equal(mod.name, 'c'))
	it('second reads its fixture', () => assert.ok(fs.readFileSync(path.join(__dirname, 'c.fixture.txt'), 'utf8')))
	it('third', () => assert.ok(require('../src/shared').ok))
})
