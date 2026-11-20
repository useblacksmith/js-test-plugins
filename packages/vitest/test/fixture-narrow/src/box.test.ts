import { expect, test } from 'vitest'
import { Box } from './lib.ts'

test('box', () => expect(new Box().size()).toBe(1))
