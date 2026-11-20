import { expect, test } from 'vitest'

test('dynamic', async () => {
	const lazy = await import('./lazy.ts')
	expect(lazy.LAZY).toBe(1)
})
