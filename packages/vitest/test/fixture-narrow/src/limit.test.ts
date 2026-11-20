import { expect, test } from 'vitest'
import { LIMIT } from './lib.ts'

test('limit', () => expect(LIMIT).toBeGreaterThan(1))
