import assert from 'node:assert'
import { sub } from '../src/math.js'

describe('sub', () => {
	it('subtracts', () => assert.equal(sub(3, 2), 1))
})
