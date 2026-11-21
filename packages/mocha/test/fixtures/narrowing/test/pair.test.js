import assert from 'node:assert'
import { one, two } from '../src/pair.js'

describe('pair', () => {
	it('calls one', () => assert.equal(one(), 1))
	it('calls two', () => assert.equal(two(), 2))
})
