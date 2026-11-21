import assert from 'node:assert'
import { chainUsed } from '../src/chain.js'

describe('chain', () => {
	it('reaches a module through another', () => assert.equal(chainUsed(), 'leaf'))
})
