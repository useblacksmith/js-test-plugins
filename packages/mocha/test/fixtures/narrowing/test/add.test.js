import assert from 'node:assert'
import { add } from '../src/math.js'

describe('add', () => {
	it('adds', () => assert.equal(add(1, 2), 3))
})
