import { expect, test } from 'vitest'
import * as lib from './lib.ts'

test('namespace', () => expect(Object.keys(lib)).toContain('LIMIT'))
