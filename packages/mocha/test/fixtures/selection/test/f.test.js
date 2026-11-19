const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const mod = require('../src/f')
describe('f', () => {
	it('first', () => assert.equal(mod.name, 'f'))
	it('second reads its fixture', () => assert.ok(fs.readFileSync(path.join(__dirname, 'f.fixture.txt'), 'utf8')))
	it('third', () => assert.ok(require('../src/shared').ok))
})
