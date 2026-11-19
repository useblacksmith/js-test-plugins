import assert from 'node:assert'
import { y } from '../src/esm/y.mjs'
describe('y (esm, shared already in the module map)', () => { it('loads', () => assert.equal(y, 'esm-shared')) })
