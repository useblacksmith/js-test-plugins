import { defineConfig } from 'vitest/config'
import blacksmith from '../../src/index.ts'

export default defineConfig({
	plugins: [blacksmith({ narrow: true })],
	test: { include: ['src/**/*.test.ts'] },
})
