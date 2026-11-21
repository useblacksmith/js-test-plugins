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
 * Workspaces installed by the package manager itself: two workspaces that
 * load one package. pnpm keeps two versions side by side and links to them
 * by name; Yarn hoists one copy to the root and installs another version
 * inside the workspace that asks for it. Needs the packed plugin
 * (BLACKSMITH_E2E_TARBALL) and the registry.
 */

type Manager = 'pnpm' | 'yarn'
const YARN = 'yarn@1.22.22'

const PACKAGE = 'left-pad'
const OLD = '1.2.0'
const NEW = '1.3.0'

class Workspace {
	readonly cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bsm-install-')))
	private readonly driver: Driver
	private readonly manager: Manager
	private runs = 0

	constructor(driver: Driver, tarball: string, manager: Manager = 'pnpm') {
		this.driver = driver
		this.manager = manager
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
				...(manager === 'pnpm'
					? { packageManager: root.packageManager }
					: {
							packageManager: YARN,
							workspaces: ['packages/*'],
							// The copy at the root stays on this version whatever a workspace asks for.
							dependencies: { [PACKAGE]: NEW },
						}),
				devDependencies: {
					[driver.runner]: own.devDependencies[driver.runner],
					// Yarn installs no peer of the runner by itself.
					...(manager === 'yarn' && own.devDependencies.vite
						? { vite: own.devDependencies.vite }
						: {}),
					[`@useblacksmith/${driver.name}`]: `file:${path.resolve(tarball)}`,
				},
			}),
			...(manager === 'pnpm'
				? { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' }
				: {}),
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
		this.use('a', manager === 'pnpm' ? OLD : NEW)
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
				// Yarn takes no workspace without one.
				version: '1.0.0',
				private: true,
				dependencies: { [PACKAGE]: version },
			}),
		)
	}

	/** Puts `workspace` on `version` (all workspaces as they are, without one), installs and commits. */
	install(workspace?: string, version?: string): void {
		if (workspace && version) this.use(workspace, version)
		const args = this.manager === 'pnpm' ? ['--no-frozen-lockfile'] : ['--no-progress']
		execFileSync(this.manager, ['install', ...args], {
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

	/** Whether `workspace` has a copy of the package of its own. */
	nested(workspace: string): boolean {
		return existsSync(
			path.join(this.cwd, 'packages', workspace, 'node_modules', PACKAGE, 'package.json'),
		)
	}

	cleanup(): void {
		rmSync(this.cwd, { recursive: true, force: true })
	}
}

/** The cases to register for `driver`: none without the packed plugin. */
export function installCases(driver: Driver): Case[] {
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
		{
			name: 'yarn install: a workspace moved to a version installed inside it, and back to the one at the root, reruns its test files only',
			async run() {
				const workspace = new Workspace(driver, tarball, 'yarn')
				try {
					workspace.install()
					assert.ok(!workspace.nested('a'), 'both workspaces load the copy at the root')
					assert.deepEqual(workspace.run(), ['a', 'b'])
					assert.deepEqual(workspace.run(), [])
					// The copy at the root stays as it is: one is added in front of it.
					workspace.install('a', OLD)
					assert.ok(workspace.nested('a'), 'the workspace has a copy of its own')
					assert.deepEqual(workspace.run(), ['a'])
					assert.deepEqual(workspace.run(), [])
					workspace.install('a', NEW)
					assert.ok(!workspace.nested('a'), 'the copy of its own is gone')
					assert.deepEqual(workspace.run(), ['a'])
					assert.deepEqual(workspace.run(), [])
				} finally {
					workspace.cleanup()
				}
			},
		},
	]
}
