const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const loadtime = require('../src/loadtime')
const { getConfig } = require('../src/config')
const data = (name) => path.join(__dirname, '../data', name)

describe('a', () => {
	before(() => fs.readFileSync(data('hook.json')))
	it('reads a.json', () => assert.equal(JSON.parse(fs.readFileSync(data('a.json'), 'utf8')).name, 'a'))
	it('uses a value read at load time', () => assert.equal(loadtime.name, 'loadtime'))
	it('uses the memoized config (first call: reads)', () => assert.equal(getConfig().name, 'config'))
	it('runs a node child process', () => {
		assert.equal(spawnSync(process.execPath, [path.join(__dirname, '../scripts/child.js')], { encoding: 'utf8' }).stdout, 'child\n')
	})
	it('leaks a read past its own end', () => {
		setTimeout(() => fs.readFileSync(data('leak.json')), 30)
	})
})
