import { expect, test } from 'vitest'
import { reads } from './lib.ts'

test('reads', () => expect(reads()).toBeGreaterThan(1))
