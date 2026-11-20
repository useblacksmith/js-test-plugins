import { defineConfig } from 'vitest/config'
import blacksmith from '../../src/index.ts'

export default defineConfig({
	plugins: [blacksmith()],
	test: { include: ['src/**/*.test.ts'] },
})
