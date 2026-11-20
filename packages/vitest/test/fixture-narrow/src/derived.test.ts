import { expect, test } from 'vitest'
import { DERIVED } from './index.ts'

test('derived', () => expect(DERIVED).toBeGreaterThan(1))
