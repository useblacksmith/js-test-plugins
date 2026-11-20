import { expect, test } from 'vitest'
import { renamed } from './index.ts'

test('renamed', () => expect(renamed(3)).toBe(3))
