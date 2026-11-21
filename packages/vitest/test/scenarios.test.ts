import path from 'node:path'

import { test } from 'vitest'

import type { Driver } from '../../shared/test/project.ts'
import { installCases } from '../../shared/test/install.ts'
import { cases } from '../../shared/test/scenarios.ts'
import { packageRoot } from './harness.ts'

const driver: Driver = {
	name: 'vitest',
	packageRoot,
	style: 'esm',
	prelude: "import { it } from 'vitest'",
	runner: 'vitest',
	source: path.join(packageRoot, 'src', 'index.ts'),
	cacheDir: 'node_modules/.vite',
	tracksPackages: true,
	mergesShards: true,
	withTool: (plugin, tool) => ({
		'vitest.config.mjs': `import ${JSON.stringify(tool)}\nimport { defineConfig } from 'vitest/config'\nimport blacksmith from ${JSON.stringify(plugin)}\n\nexport default defineConfig({\n\tplugins: [blacksmith()],\n\ttest: { include: ['test/*.test.js'] },\n})\n`,
	}),
	config: (plugin) => ({
		'vitest.config.mjs': `import { defineConfig } from 'vitest/config'\nimport blacksmith from ${JSON.stringify(plugin)}\n\nexport default defineConfig({\n\tplugins: [blacksmith()],\n\ttest: { include: ['test/*.test.js'] },\n})\n`,
	}),
	command: (project, report) => [
		path.join(project.cwd, 'node_modules', 'vitest', 'vitest.mjs'),
		'run',
		'--reporter=json',
		`--outputFile=${report}`,
		// A shard of the three test files may own none.
		...(project.shard
			? [`--shard=${project.shard}`, '--passWithNoTests']
			: []),
	],
	files: (report) =>
		(report as { testResults: { name: string }[] }).testResults.map(
			(result) => result.name,
		),
}

for (const { name, run } of cases(driver)) test(name, run)
for (const { name, run } of installCases(driver)) {
	test(name, { timeout: 300_000 }, run)
}
