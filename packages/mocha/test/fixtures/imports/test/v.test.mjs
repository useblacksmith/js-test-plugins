import assert from 'node:assert'
import { viaCjs } from '../src/esm/uses-cjs.mjs'
describe('v (esm importing cjs)', () => { it('loads', () => assert.equal(viaCjs, 'shared')) })
