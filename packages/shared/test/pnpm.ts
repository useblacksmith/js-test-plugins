import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Driver, Project } from './project.ts'
import type { Case } from './scenarios.ts'

/**
 * A pnpm workspace installed by pnpm itself: two workspaces on two versions
 * of one package, which pnpm keeps side by side and links to by name. Needs
 * the packed plugin (BLACKSMITH_E2E_TARBALL) and the registry.
 */

const PACKAGE = 'left-pad'
const OLD = '1.2.0'
const NEW = '1.3.0'

class Workspace {
	readonly cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bsm-pnpm-')))
	private readonly driver: Driver
	private runs = 0

	constructor(driver: Driver, tarball: string) {
		this.driver = driver
		const own = JSON.parse(
			readFileSync(path.join(driver.packageRoot, 'package.json'), 'utf8'),
		) as { devDependencies: Record<string, string> }
		const root = JSON.parse(
			readFileSync(path.join(driver.packageRoot, '../../package.json'), 'utf8'),
		) as { packageManager: string }
		const esm = driver.style === 'esm'
		const files: Record<string, string> = {
			'package.json': JSON.stringify({
				name: 'sample',
				private: true,
				packageManager: root.packageManager,
				devDependencies: {
					[driver.runner]: own.devDependencies[driver.runner],
					[`@useblacksmith/${driver.name}`]: `file:${path.resolve(tarball)}`,
				},
			}),
			'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
			'.gitignore': 'node_modules\n',
			...driver.config(`@useblacksmith/${driver.name}`),
		}
		for (const name of ['a', 'b']) {
			files[`packages/${name}/pad.js`] = esm
				? `import pad from '${PACKAGE}'\nexport const ${name} = () => pad('${name}', 3)\n`
				: `const pad = require('${PACKAGE}')\nexports.${name} = () => pad('${name}', 3)\n`
			files[`test/${name}.test.js`] = [
				...(driver.prelude === '' ? [] : [driver.prelude]),
				esm ? "import assert from 'node:assert'" : "const assert = require('node:assert')",
				esm
					? `import { ${name} } from '../packages/${name}/pad.js'`
					: `const { ${name} } = require('../packages/${name}/pad.js')`,
				`it('${name}', () => assert.equal(${name}(), '  ${name}'))`,
				'',
			].join('\n')
		}
		for (const [file, content] of Object.entries(files)) this.write(file, content)
		this.use('a', OLD)
		this.use('b', NEW)
		this.git('init', '-q', '-b', 'main')
	}

	private write(file: string, content: string): void {
		mkdirSync(path.dirname(path.join(this.cwd, file)), { recursive: true })
		writeFileSync(path.join(this.cwd, file), content)
	}

	private git(...args: string[]): void {
		execFileSync(
			'git',
			['-c', 'user.name=ci', '-c', 'user.email=ci@example.com', ...args],
			{ cwd: this.cwd, stdio: 'pipe' },
		)
	}

	private use(workspace: string, version: string): void {
		this.write(
			`packages/${workspace}/package.json`,
			JSON.stringify({
				name: workspace,
				private: true,
				dependencies: { [PACKAGE]: version },
			}),
		)
	}

	/** Puts `workspace` on `version` (all workspaces as they are, without one), installs and commits. */
	install(workspace?: string, version?: string): void {
		if (workspace && version) this.use(workspace, version)
		execFileSync('pnpm', ['install', '--no-frozen-lockfile'], {
			cwd: this.cwd,
			stdio: 'pipe',
			env: { ...process.env, CI: 'true' },
		})
		this.git('add', '-A')
		this.git('commit', '-q', '-m', `install ${workspace ?? ''} ${version ?? ''}`)
	}

	/** The store entries of the package: both versions stay installed throughout. */
	stored(): boolean {
		return [OLD, NEW].every((version) =>
			existsSync(path.join(this.cwd, 'node_modules/.pnpm', `${PACKAGE}@${version}`)),
		)
	}

	/** Runs the tests; the names of the test files that ran. */
	run(): string[] {
		const report = path.join(this.cwd, 'node_modules', `report-${this.runs++}.json`)
		const project = { cwd: this.cwd, installed: true, driver: this.driver }
		const child = spawnSync(
			process.execPath,
			this.driver.command(project as unknown as Project, report),
			{
				cwd: this.cwd,
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH ?? '',
					HOME: process.env.HOME ?? '',
					CI: 'true',
				},
			},
		)
		const output = `${child.stdout}${child.stderr}`
		assert.equal(child.status, 0, output)
		const files = existsSync(report)
			? this.driver.files(JSON.parse(readFileSync(report, 'utf8')))
			: []
		return [...new Set(files.map((file) => path.basename(file, '.test.js')))].sort()
	}

	cleanup(): void {
		rmSync(this.cwd, { recursive: true, force: true })
	}
}

/** The cases to register for `driver`: none without the packed plugin. */
export function pnpmCases(driver: Driver): Case[] {
	const tarball = process.env.BLACKSMITH_E2E_TARBALL
	if (!tarball || !driver.tracksPackages) return []
	return [
		{
			name: 'pnpm install: a workspace moved to a version that is already installed, and back, reruns its test files only',
			async run() {
				const workspace = new Workspace(driver, tarball)
				try {
					workspace.install()
					assert.deepEqual(workspace.run(), ['a', 'b'])
					assert.deepEqual(workspace.run(), [])
					// `b` is on it already: nothing is added to the store, one link moves.
					workspace.install('a', NEW)
					assert.ok(workspace.stored(), 'both versions stay in the store')
					assert.deepEqual(workspace.run(), ['a'])
					assert.deepEqual(workspace.run(), [])
					workspace.install('a', OLD)
					assert.ok(workspace.stored(), 'both versions stay in the store')
					assert.deepEqual(workspace.run(), ['a'])
					assert.deepEqual(workspace.run(), [])
				} finally {
					workspace.cleanup()
				}
			},
		},
	]
}
