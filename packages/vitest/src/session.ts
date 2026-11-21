import path from 'node:path'

import picomatch from 'picomatch'
import type { TestSpecification, Vitest } from 'vitest/node'

import { toRelative } from '../../core/src/anchor.ts'
import { Session, type Pending } from '../../core/src/engine.ts'
import { repoRoot } from '../../core/src/git.ts'
import { specKey } from '../../core/src/record.ts'
import type { Options } from '../../core/src/select.ts'
import { shardOwner } from './sequencer.ts'
import { digester } from './units.ts'

/** What one Vitest run shares between the provider that selects and the reporter that records. */
export interface RunState {
	repo: string
	session: Session
	/** What the selection decided, once it has. */
	pending: Pending | null
	/** The test files (absolute) the selection left out. */
	deselected: Set<string>
}

/** What the plugin was given that the selection needs. */
export interface Settings {
	options: Options
	/** Whether to look inside a changed file instead of rerunning every test file that loaded it. */
	narrow: boolean
}

// On the process: a project with its own root evaluates the config, and so
// the plugin, a second time.
const STATES = Symbol.for('blacksmith.vitest.runStates')
const states = ((globalThis as unknown as {
	[STATES]?: WeakMap<Vitest, Promise<RunState>>
})[STATES] ??= new WeakMap())

function projectNames(vitest: Vitest): string[] {
	return vitest.projects.map((project) => project.name).sort()
}

/** The selection for this run: the shared core, told where Vitest runs and what its config says reruns everything. */
export function runState(vitest: Vitest, settings: Settings): Promise<RunState> {
	let state = states.get(vitest)
	if (!state) {
		state = (async (): Promise<RunState> => {
			const { root, forceRerunTriggers } = vitest.config
			const repo = await repoRoot(root)
			// The root config and what it imports: Vitest 4 names them in no pattern that matches a file.
			const { configFile, configFileDependencies } = vitest.vite.config
			const configs = new Set(
				[...(configFile ? [configFile] : []), ...configFileDependencies].map((file) =>
					path.resolve(root, file).split(path.sep).join('/'),
				),
			)
			const forced =
				forceRerunTriggers.length > 0 ? picomatch(forceRerunTriggers, { dot: true }) : null
			const session = new Session({
				name: 'vitest',
				repo,
				cwd: root,
				// Beside Vitest's own cache, wherever the config puts it.
				dir: path.join(vitest.vite.config.cacheDir, 'blacksmith'),
				options: settings.options,
				// Vitest's config files are what its own process loaded: the record names them.
				always: [],
				rulesBase: root,
				// Invocations covering different project sets keep separate records, as their cache keys do.
				...(vitest.config.project.length > 0
					? { part: projectNames(vitest).join('\n') }
					: {}),
				digester: settings.narrow ? digester(repo) : undefined,
				triggers: (file: string) => {
					const absolute = path.join(repo, file).split(path.sep).join('/')
					return configs.has(absolute) || (forced?.(absolute) ?? false)
				},
				log: (message) => vitest.logger.log(`[blacksmith] ${message}`),
				warn: (message) => vitest.logger.warn(`[blacksmith] ${message}`),
			})
			return { repo, session, pending: null, deselected: new Set() }
		})()
		states.set(vitest, state)
	}
	return state
}

/** A test file of a project, as the record names it. */
export function keyOf(repo: string, moduleId: string, project: string): string {
	return specKey(toRelative(repo, moduleId), project === '' ? undefined : project)
}

/**
 * The specifications this shard runs, independent of the selection. A file
 * may run in several projects, and on this shard in some of them.
 */
export async function ownedSpecifications(vitest: Vitest): Promise<TestSpecification[]> {
	const owns = await shardOwner(vitest)
	return (await vitest.globTestSpecifications()).filter(({ moduleId, project }) =>
		owns(moduleId, project.name),
	)
}
