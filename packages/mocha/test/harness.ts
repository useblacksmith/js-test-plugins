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

import { closure, type RunRecord } from '../src/core.ts'

export const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
)
const cli = path.join(packageRoot, 'src', 'cli.ts')
export const register = path.join(packageRoot, 'src', 'register.ts')
export const mocharc = path.join(packageRoot, 'src', 'mocharc.cts')

export interface Result {
	status: number
	output: string
	/** The `[blacksmith]` and `  run  ` lines. */
	lines: string[]
}

/** A copy of `test/fixtures/<fixture>` as a git repository of its own, with this package's Mocha installed. */
export class Repo {
	readonly cwd: string
	env: Record<string, string> = {}

	constructor(fixture: string) {
		this.cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bsm-mocha-')))
		cpSync(path.join(packageRoot, 'test', 'fixtures', fixture), this.cwd, {
			recursive: true,
		})
		mkdirSync(path.join(this.cwd, 'node_modules'))
		symlinkSync(
			path.join(packageRoot, 'node_modules', 'mocha'),
			path.join(this.cwd, 'node_modules', 'mocha'),
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

	private spawn(args: string[]): Result {
		const result = spawnSync(process.execPath, args, {
			cwd: this.cwd,
			encoding: 'utf8',
			env: { ...process.env, ...this.env },
		})
		const output = `${result.stdout}${result.stderr}`
		return {
			status: result.status ?? 1,
			output,
			lines: output
				.split('\n')
				.filter((line) => /^\[blacksmith\]|^ {2}run {2}/.test(line)),
		}
	}

	/** `blacksmith-mocha <args>`. */
	cli(...args: string[]): Result {
		return this.spawn([cli, ...args])
	}

	/** Plain `mocha <args>`, as a project with a `.mocharc.cjs` runs it. */
	mocha(...args: string[]): Result {
		return this.spawn([
			path.join(this.cwd, 'node_modules', 'mocha', 'bin', 'mocha.js'),
			...args,
		])
	}

	/** Runs Mocha with only the recorder preloaded and returns what it recorded. */
	record(...args: string[]): { result: Result; run: RunRecord } {
		const file = path.join(this.cwd, 'node_modules', 'run.json')
		this.env.BLACKSMITH_MOCHA_RUN = file
		const result = this.mocha('--require', register, ...args)
		delete this.env.BLACKSMITH_MOCHA_RUN
		return { result, run: JSON.parse(readFileSync(file, 'utf8')) as RunRecord }
	}

	/** Which spec files the last `cli('run', …)` or `cli('affected', …)` output names as affected, without `test/` and the extension. */
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

/** Every file the run recorded `spec` as depending on, the spec itself aside. */
export function dependenciesOf(run: RunRecord, spec: string): string[] {
	const entry = run.files[spec]
	const files = closure(run.graph, [
		spec,
		...run.global,
		...(entry?.hooks ?? []),
		...Object.values(entry?.tests ?? {}).flatMap((test) => test.deps),
	])
	files.delete(spec)
	return [...files].sort()
}
