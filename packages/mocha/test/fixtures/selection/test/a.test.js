const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const mod = require('../src/a')
describe('a', () => {
	it('first', () => assert.equal(mod.name, 'a'))
	it('second reads its fixture', () => assert.ok(fs.readFileSync(path.join(__dirname, 'a.fixture.txt'), 'utf8')))
	it('third', () => assert.ok(require('../src/shared').ok))
})
