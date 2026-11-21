import assert from 'node:assert'
import { TABLE } from '../src/math.js'

describe('table', () => {
	it('is built when the module loads', () => assert.equal(TABLE.length, 3))
})
