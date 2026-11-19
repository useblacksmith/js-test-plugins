import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** What one plugin needs to run the sample project. */
export interface Driver {
	name: string
	packageRoot: string
	/** The module syntax of the sample's sources and test files. */
	style: 'cjs' | 'esm'
	/** First line of every test file: where `it` comes from, if not a global. */
	prelude: string
	/** The test runner's package name. */
	runner: string
	/** The plugin's source entry, for a run from this checkout. */
	source: string
	/** The directory under the project that holds the plugin's record. */
	cacheDir: string
	/** Whether a lockfile change reruns only the tests that loaded a package whose version changed. */
	tracksPackages?: true
	/** A config file that also loads the package `tool`, as a plugin or a transformer would be. */
	withTool?(plugin: string, tool: string): Record<string, string>
	/** Config files of the sample; `plugin` is what they load the plugin by. */
	config(plugin: string): Record<string, string>
	/** `node` arguments of one run that writes the runner's JSON report to `report`. */
	command(project: Project, report: string): string[]
	/** The test files (absolute or relative) the JSON report says ran. */
	files(report: unknown): string[]
}

export interface Run {
	status: number
	output: string
	/** Names of the test files that ran, without `.test.js`, sorted. */
	ran: string[]
}

const WORKFLOW = '.github/workflows/ci.yml'

/** A test file that checks `<module>()` returns `expected`. */
export function testFile(
	driver: Pick<Driver, 'style' | 'prelude'>,
	module: string,
	expected: string,
): string {
	const lines =
		driver.style === 'esm'
			? [
					"import assert from 'node:assert'",
					`import { ${module} } from '../src/${module}.js'`,
				]
			: [
					"const assert = require('node:assert')",
					`const { ${module} } = require('../src/${module}.js')`,
				]
	return [
		driver.prelude,
		...lines,
		`it('${module}', () => assert.equal(${module}(), '${expected}'))`,
		'',
	]
		.filter((line, index) => index > 0 || line !== '')
		.join('\n')
}

function sample(driver: Driver, plugin: string): Record<string, string> {
	const esm = driver.style === 'esm'
	return {
		'src/b.js': esm
			? "export const b = () => 'b'\n"
			: "exports.b = () => 'b'\n",
		'src/a.js': esm
			? "import { b } from './b.js'\nexport const a = () => `a:${b()}`\n"
			: "const { b } = require('./b.js')\nexports.a = () => `a:${b()}`\n",
		// Read when the test runs, not when the module loads.
		'src/c.js': esm
			? "import fs from 'node:fs'\nexport const c = () => fs.readFileSync('data/c.txt', 'utf8').split('\\n')[0]\n"
			: "const fs = require('node:fs')\nexports.c = () => fs.readFileSync('data/c.txt', 'utf8').split('\\n')[0]\n",
		'data/c.txt': 'ok\n',
		'test/a.test.js': testFile(driver, 'a', 'a:b'),
		'test/b.test.js': testFile(driver, 'b', 'b'),
		'test/c.test.js': testFile(driver, 'c', 'ok'),
		'README.md': '# sample\n',
		[WORKFLOW]: 'name: CI\non: push\n',
		'.gitignore': 'node_modules\n',
		...driver.config(plugin),
	}
}

/** Where the plugin and its runner come from: this checkout, or the packed tarball installed with npm. */
const tarball = (): string | undefined =>
	process.env.BLACKSMITH_E2E_TARBALL || undefined

const installs = new Map<string, string>()

/** One `npm install` of the tarball and the runner per process; projects link to its node_modules. */
function installed(driver: Driver, file: string): string {
	const known = installs.get(driver.name)
	if (known) return known
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bsm-install-')))
	const own = JSON.parse(
		readFileSync(path.join(driver.packageRoot, 'package.json'), 'utf8'),
	) as { devDependencies: Record<string, string> }
	writeFileSync(
		path.join(dir, 'package.json'),
		`${JSON.stringify({ name: 'sample', private: true }, null, 2)}\n`,
	)
	execFileSync(
		'npm',
		[
			'install',
			'--no-audit',
			'--no-fund',
			path.resolve(file),
			`${driver.runner}@${own.devDependencies[driver.runner]}`,
		],
		{ cwd: dir, stdio: 'pipe' },
	)
	installs.set(driver.name, dir)
	return dir
}

/** The sample project as a git repository of its own, run with one plugin. */
export class Project {
	readonly cwd: string
	readonly driver: Driver
	readonly installed: boolean
	/** What the sample's config loads the plugin by. */
	readonly plugin: string
	/** Extra environment of the next runs. */
	env: Record<string, string> = {}
	/** The job the runs claim to be: cache entries are kept per job. */
	job = `e2e-${randomUUID()}`
	private readonly cacheUrl: string | undefined
	private runs = 0

	/** With `cacheUrl`, the record travels only through that cache: every run starts without the one on disk. */
	constructor(driver: Driver, cacheUrl?: string) {
		this.driver = driver
		this.cacheUrl = cacheUrl
		this.cwd = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), `bsm-${driver.name}-`)),
		)
		const file = tarball()
		this.installed = file !== undefined
		const modules = path.join(this.cwd, 'node_modules')
		mkdirSync(modules)
		if (file !== undefined) {
			const from = installed(driver, file)
			for (const name of ['package.json', 'package-lock.json']) {
				cpSync(path.join(from, name), path.join(this.cwd, name))
			}
			for (const name of readdirSync(path.join(from, 'node_modules'))) {
				if (name.startsWith('.')) continue
				symlinkSync(
					path.join(from, 'node_modules', name),
					path.join(modules, name),
				)
			}
		} else {
			this.write('package.json', '{\n  "name": "sample",\n  "private": true\n}\n')
			this.write('package-lock.json', '{\n  "lockfileVersion": 3\n}\n')
			symlinkSync(
				path.join(driver.packageRoot, 'node_modules', driver.runner),
				path.join(modules, driver.runner),
			)
		}
		this.plugin =
			file !== undefined ? `@useblacksmith/${driver.name}` : driver.source
		for (const [name, content] of Object.entries(sample(driver, this.plugin))) {
			this.write(name, content)
		}
		this.git('init', '-q', '-b', 'main')
		this.commit('initial')
	}

	git(...args: string[]): string {
		return execFileSync(
			'git',
			['-c', 'user.name=ci', '-c', 'user.email=ci@example.com', ...args],
			{ cwd: this.cwd, encoding: 'utf8' },
		)
	}

	commit(message: string): void {
		this.git('add', '-A')
		this.git('commit', '-q', '-m', message)
	}

	write(file: string, content: string): void {
		mkdirSync(path.dirname(path.join(this.cwd, file)), { recursive: true })
		writeFileSync(path.join(this.cwd, file), content)
	}

	/** Installs `name` at `version`: a CommonJS package whose export returns its name. Not in git, as node_modules is not. */
	install(name: string, version: string): void {
		const dir = `node_modules/${name}`
		this.write(`${dir}/package.json`, `${JSON.stringify({ name, version, main: 'index.js' })}\n`)
		this.write(`${dir}/index.js`, `module.exports = () => ${JSON.stringify(name)}\n`)
	}

	/** A test file named `name` that loads the package `name`. */
	packageTest(name: string): string {
		const lines =
			this.driver.style === 'esm'
				? ["import assert from 'node:assert'", `import loaded from '${name}'`]
				: ["const assert = require('node:assert')", `const loaded = require('${name}')`]
		return [
			...(this.driver.prelude === '' ? [] : [this.driver.prelude]),
			...lines,
			`it('${name}', () => assert.equal(loaded(), '${name}'))`,
			'',
		].join('\n')
	}

	read(file: string): string {
		return readFileSync(path.join(this.cwd, file), 'utf8')
	}

	/** Writes `file` and commits: a cache entry is saved once per commit. */
	change(file: string, content: string): void {
		this.write(file, content)
		this.commit(`change ${file}`)
	}

	run(): Promise<Run> {
		if (this.cacheUrl !== undefined) {
			rmSync(path.join(this.cwd, this.driver.cacheDir), {
				recursive: true,
				force: true,
			})
		}
		const report = path.join(
			this.cwd,
			'node_modules',
			`report-${this.runs++}.json`,
		)
		return new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				this.driver.command(this, report),
				{
					cwd: this.cwd,
					env: {
						PATH: process.env.PATH ?? '',
						HOME: process.env.HOME ?? '',
						CI: 'true',
						// The job a workflow of the sample repository would run.
						GITHUB_REPOSITORY: 'acme/sample',
						GITHUB_WORKFLOW_REF: `acme/sample/${WORKFLOW}@refs/heads/main`,
						GITHUB_JOB: this.job,
						...(this.cacheUrl !== undefined
							? { ACTIONS_RESULTS_URL: this.cacheUrl }
							: {}),
						...this.env,
					},
				},
			)
			let output = ''
			child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
			child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
			child.on('error', reject)
			child.on('close', (status) => {
				const files = existsSync(report)
					? this.driver.files(JSON.parse(readFileSync(report, 'utf8')))
					: []
				const ran = [
					...new Set(files.map((file) => path.basename(file, '.test.js'))),
				].sort()
				resolve({ status: status ?? -1, output, ran })
			})
		})
	}

	cleanup(): void {
		rmSync(this.cwd, { recursive: true, force: true })
	}
}

export const WORKFLOW_FILE = WORKFLOW
