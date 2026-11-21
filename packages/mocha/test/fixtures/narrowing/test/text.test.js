import assert from 'node:assert'
import fs from 'node:fs'
import { one } from '../src/pair.js'

describe('text', () => {
	it('reads the source of a module it also imports', () => {
		assert.equal(one(), 1)
		assert.match(fs.readFileSync(new URL('../src/pair.js', import.meta.url), 'utf8'), /two/)
	})
})
