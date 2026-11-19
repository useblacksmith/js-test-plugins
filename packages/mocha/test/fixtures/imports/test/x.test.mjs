import assert from 'node:assert'
import { x } from '../src/esm/x.mjs'
describe('x (esm)', () => { it('loads', () => assert.equal(x, 'esm-shared')) })
