import path from 'node:path'
import { test } from 'node:test'

import type { Driver } from '../../shared/test/project.ts'
import { installCases } from '../../shared/test/install.ts'
import { cases } from '../../shared/test/scenarios.ts'
import { packageRoot } from './harness.ts'

const driver: Driver = {
	name: 'jest',
	packageRoot,
	style: 'cjs',
	prelude: '',
	runner: 'jest',
	source: path.join(packageRoot, 'src', 'index.ts'),
	cacheDir: 'node_modules/.cache/blacksmith-jest',
	tracksPackages: true,
	withTool: (plugin, tool) => ({
		'jest.config.js': `require(${JSON.stringify(tool)})\nconst { withBlacksmith } = require(${JSON.stringify(plugin)})\nmodule.exports = withBlacksmith({ watchman: false })\n`,
	}),
	config: (plugin) => ({
		'jest.config.js': `const { withBlacksmith } = require(${JSON.stringify(plugin)})\nmodule.exports = withBlacksmith({ watchman: false })\n`,
	}),
	mergesShards: true,
	command: (project, report) => [
		path.join(project.cwd, 'node_modules', 'jest', 'bin', 'jest.js'),
		'--json',
		`--outputFile=${report}`,
		// A shard of the three test files may own none.
		...(project.shard === null
			? []
			: [`--shard=${project.shard}`, '--passWithNoTests']),
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
