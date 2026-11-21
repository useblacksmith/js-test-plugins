import { createRequire } from 'node:module'

import { ENV_REPO } from '../../shared/src/fs-recorder.ts'
import { HITS } from '../../shared/src/hits.ts'
import { markTransforms } from './mark.ts'
import { begin, end } from './record.ts'
import { ENV_NARROW, ENV_RUNTIME, projectName, resolveFromJest } from './state.ts'

/**
 * The `runtime` of a project config: the project's own `jest-runtime`, which
 * Jest constructs once per test file in the process that runs it, with the
 * recording started when it is constructed and written when it is torn down.
 */
interface RuntimeClass {
	new (...args: unknown[]): { teardown(): void }
}

const require = createRequire(import.meta.url)
const loaded = require(
	process.env[ENV_RUNTIME] ?? resolveFromJest(process.cwd(), 'jest-runtime'),
) as { default?: RuntimeClass } & RuntimeClass
const Base: RuntimeClass = loaded.default ?? loaded

interface Environment {
	global?: { process?: { env?: NodeJS.ProcessEnv }; [HITS]?: Hits }
}

/** Module → the functions entered in it. */
type Hits = Record<string, Record<string, 1>>

export default class BlacksmithRuntime extends Base {
	/** Source text of every file Jest reads as a module of this test file, by path: Jest fills it as it loads them. */
	private readonly blacksmithSources: Map<string, unknown> | undefined
	/** What the marked modules of this test file report to; kept here, as an environment lets go of its global when it is torn down. */
	private readonly blacksmithHits: Hits | undefined

	// (config, environment, resolver, transformer, cacheFS, coverageOptions, testPath, globalConfig)
	constructor(...args: unknown[]) {
		super(...args)
		const sources = args[4]
		this.blacksmithSources = sources instanceof Map ? sources : undefined
		const repo = process.env[ENV_REPO]
		const global = (args[1] as Environment | undefined)?.global
		if (process.env[ENV_NARROW] && repo && global && markTransforms(args[3], repo)) {
			this.blacksmithHits = global[HITS] ??= {}
		}
		const testPath = args[6]
		if (typeof testPath === 'string') {
			begin(
				testPath,
				(args[1] as Environment | undefined)?.global?.process?.env,
				projectName(args[0] as Parameters<typeof projectName>[0], repo ?? ''),
			)
		}
	}

	override teardown(): void {
		end(
			(this.blacksmithSources?.keys() ?? []) as Iterable<string>,
			this.blacksmithHits,
		)
		super.teardown()
	}
}
