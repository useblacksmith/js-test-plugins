import { expect, test } from 'vitest'
import { called } from './index.ts'

test('called', () => expect(called(1)).toBe(2))
