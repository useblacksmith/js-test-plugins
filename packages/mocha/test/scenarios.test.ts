import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import type { Driver } from '../../shared/test/project.ts'
import { pnpmCases } from '../../shared/test/pnpm.ts'
import { cases } from '../../shared/test/scenarios.ts'
import { packageRoot } from './harness.ts'

const driver: Driver = {
	name: 'mocha',
	packageRoot,
	style: 'cjs',
	prelude: '',
	runner: 'mocha',
	source: path.join(packageRoot, 'src', 'cli.ts'),
	cacheDir: 'node_modules/.cache/blacksmith-mocha',
	tracksPackages: true,
	withTool: (_plugin, tool) => ({
		'.mocharc.cjs': `require(${JSON.stringify(tool)})\nmodule.exports = {}\n`,
	}),
	config: () => ({}),
	command(project, report) {
		const plugin = path.join(project.cwd, 'node_modules/@useblacksmith/mocha')
		const cli = project.installed
			? path.join(
					plugin,
					(
						JSON.parse(
							readFileSync(path.join(plugin, 'package.json'), 'utf8'),
						) as { bin: Record<string, string> }
					).bin['blacksmith-mocha'] ?? '',
				)
			: this.source
		return [
			cli,
			'run',
			'--',
			'test/*.test.js',
			'--reporter',
			'json',
			'--reporter-option',
			`output=${report}`,
		]
	},
	files: (report) =>
		(report as { tests: { file: string }[] }).tests.map((entry) => entry.file),
}

for (const { name, run } of cases(driver)) test(name, run)
for (const { name, run } of pnpmCases(driver)) {
	test(name, { timeout: 300_000 }, run)
}
