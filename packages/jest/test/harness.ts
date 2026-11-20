import { execFileSync, spawnSync } from 'node:child_process'
import {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRecords, type Records, type StoredRecords } from '../src/core.ts'

export const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
)
const entry = path.join(packageRoot, 'src', 'index.ts')

export interface Result {
	status: number
	stdout: string
	/** stdout and stderr. */
	output: string
	/** The `[blacksmith]` and `  run  ` lines. */
	lines: string[]
}

/** A copy of `test/fixtures/<fixture>` as a git repository of its own, with this package's Jest installed. */
export class Repo {
	readonly cwd: string
	env: Record<string, string> = {}

	constructor(fixture: string) {
		this.cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bsm-jest-')))
		cpSync(path.join(packageRoot, 'test', 'fixtures', fixture), this.cwd, {
			recursive: true,
		})
		mkdirSync(path.join(this.cwd, 'node_modules'))
		symlinkSync(
			path.join(packageRoot, 'node_modules', 'jest'),
			path.join(this.cwd, 'node_modules', 'jest'),
		)
		this.write('.gitignore', 'node_modules\ndist\n')
		this.git('init', '-q', '-b', 'main')
		this.git('add', '-A')
		this.git('commit', '-q', '-m', 'init')
	}

	git(...args: string[]): string {
		return execFileSync(
			'git',
			['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
			{ cwd: this.cwd, encoding: 'utf8' },
		)
	}

	write(file: string, content: string): void {
		mkdirSync(path.dirname(path.join(this.cwd, file)), { recursive: true })
		writeFileSync(path.join(this.cwd, file), content)
	}

	append(file: string, content: string): void {
		appendFileSync(path.join(this.cwd, file), content)
	}

	read(file: string): string {
		return readFileSync(path.join(this.cwd, file), 'utf8')
	}

	/** The environment of a run: this process's without what a CI job adds, so a fixture never reaches the job's real cache. */
	environment(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env }
		for (const name of [
			'ACTIONS_RESULTS_URL',
			'ACTIONS_CACHE_MODE',
			'GITHUB_WORKFLOW_REF',
			'GITHUB_REPOSITORY',
			'GITHUB_JOB',
		]) {
			delete env[name]
		}
		return { ...env, BLACKSMITH_JEST_ENTRY: entry, ...this.env }
	}

	private spawn(args: string[]): Result {
		const result = spawnSync(process.execPath, args, {
			cwd: this.cwd,
			encoding: 'utf8',
			env: this.environment(),
		})
		const output = `${result.stdout}${result.stderr}`
		return {
			status: result.status ?? 1,
			stdout: result.stdout,
			output,
			lines: output
				.split('\n')
				.filter((line) => /^\[blacksmith\]|^ {2}run {2}/.test(line)),
		}
	}

	/** `jest <args>`. */
	jest(...args: string[]): Result {
		return this.spawn([
			path.join(this.cwd, 'node_modules', 'jest', 'bin', 'jest.js'),
			...args,
		])
	}

	records(shard = ''): Records {
		const records = loadRecords(
			JSON.parse(
				this.read(`node_modules/.cache/blacksmith-jest/records${shard}.json`),
			) as StoredRecords,
		)
		if (!records) throw new Error('no dependency record')
		return records
	}

	/** Which test files the output of a run names as affected, without `test/` and the extension. */
	static ran(result: Result): string[] {
		return result.lines
			.filter((line) => line.startsWith('  run  '))
			.map((line) => path.basename(line.split(/\s+/)[2] ?? '').split('.')[0] ?? '')
			.sort()
	}

	cleanup(): void {
		rmSync(this.cwd, { recursive: true, force: true })
	}
}
