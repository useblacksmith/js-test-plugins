import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENV_REPO } from '../../shared/src/fs-recorder.ts'
import type { Options } from './core.ts'
import {
	ENV_NARROW,
	ENV_RECORD,
	ENV_RUNTIME,
	dataDir,
	resolveFromJest,
	state,
} from './state.ts'

export type { Options } from './core.ts'

type JestConfig = Record<string, unknown> & {
	projects?: unknown[]
	reporters?: unknown[]
	runtime?: string
	testSequencer?: string
	passWithNoTests?: boolean
	collectCoverage?: boolean
}

type ConfigInput = JestConfig | (() => JestConfig | Promise<JestConfig>)

const here = path.dirname(fileURLToPath(import.meta.url))
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
const moduleFile = (name: string): string =>
	path.join(here, `${name}.${extension}`)

function refuseRuntime(config: JestConfig): JestConfig {
	if (config.runtime !== undefined) {
		throw new Error(
			`@useblacksmith/jest sets \`runtime\` itself and cannot wrap the one the config names (${config.runtime})`,
		)
	}
	return config
}

function apply(config: JestConfig, options: Options): JestConfig {
	for (const name of ['runtime', 'testSequencer'] as const) {
		if (config[name] !== undefined) {
			throw new Error(
				`@useblacksmith/jest sets \`${name}\` itself and cannot wrap the one the config names (${config[name]})`,
			)
		}
	}
	const ctx = state()
	ctx.options = options
	ctx.passWithNoTests = config.passWithNoTests === true
	ctx.coverage =
		config.collectCoverage === true ||
		process.argv.some((arg) =>
			/^--(coverage|collectCoverage)($|=(?!false$))/.test(arg),
		)
	// Coverage runs every test file, and counts the marks as code.
	ctx.narrow = !ctx.coverage
	if (ctx.narrow) process.env[ENV_NARROW] = '1'
	else delete process.env[ENV_NARROW]
	process.env[ENV_REPO] = ctx.repo
	process.env[ENV_RUNTIME] = resolveFromJest(ctx.cwd, 'jest-runtime')
	if (process.env[ENV_RECORD] === undefined) {
		const dir = dataDir(ctx.cwd)
		mkdirSync(dir, { recursive: true })
		process.env[ENV_RECORD] = mkdtempSync(path.join(dir, 'run-'))
	}
	const runtime = moduleFile('runtime')
	return {
		...config,
		runtime,
		testSequencer: moduleFile('sequencer'),
		reporters: [...(config.reporters ?? ['default']), moduleFile('reporter')],
		// A run the change leaves no test file of is a pass.
		passWithNoTests: true,
		...(config.projects
			? {
					projects: config.projects.map((project) =>
						typeof project === 'object' && project !== null
							? { ...refuseRuntime(project as JestConfig), runtime }
							: project,
					),
				}
			: {}),
	}
}

/**
 * Wraps a Jest config so that runs record what each test file depends on and
 * later runs skip the test files no change affects.
 *
 * e.g. `module.exports = withBlacksmith({ testEnvironment: 'node' })`
 */
export function withBlacksmith(
	config: JestConfig,
	options?: Options,
): JestConfig
export function withBlacksmith(
	config: () => JestConfig | Promise<JestConfig>,
	options?: Options,
): () => Promise<JestConfig>
export function withBlacksmith(
	config: ConfigInput = {},
	options: Options = {},
): JestConfig | (() => Promise<JestConfig>) {
	if (typeof config === 'function') {
		return async () => apply(await config(), options)
	}
	return apply(config, options)
}

export default withBlacksmith
