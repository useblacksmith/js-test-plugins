const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const mod = require('../src/b')
describe('b', () => {
	it('first', () => assert.equal(mod.name, 'b'))
	it('second reads its fixture', () => assert.ok(fs.readFileSync(path.join(__dirname, 'b.fixture.txt'), 'utf8')))
	it('third', () => assert.ok(require('../src/shared').ok))
})
