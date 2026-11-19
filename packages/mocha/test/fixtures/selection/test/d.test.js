const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const mod = require('../src/d')
describe('d', () => {
	it('first', () => assert.equal(mod.name, 'd'))
	it('second reads its fixture', () => assert.ok(fs.readFileSync(path.join(__dirname, 'd.fixture.txt'), 'utf8')))
	it('third', () => assert.ok(require('../src/shared').ok))
})
