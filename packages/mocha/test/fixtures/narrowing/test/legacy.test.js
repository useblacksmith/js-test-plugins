import assert from 'node:assert'
import legacy from '../src/legacy.cjs'

describe('legacy', () => {
	it('calls a CommonJS function', () => assert.equal(legacy.used(), 'used'))
})
