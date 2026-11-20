import { expect, test } from 'vitest'
import { arrow } from './index.ts'

test('arrow', () => expect(arrow(2)).toBe(4))
