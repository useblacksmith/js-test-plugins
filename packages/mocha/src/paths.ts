import path from 'node:path'

/** Overrides where the record, anchor and run files are kept. */
export const ENV_DIR = 'BLACKSMITH_MOCHA_DIR'
/** Where the preload writes what the run recorded; `run.json` in the data directory by default. */
export const ENV_RUN = 'BLACKSMITH_MOCHA_RUN'
/** Set by the `.mocharc` helper: the preload merges the run into the record when Mocha exits. */
export const ENV_COMMIT = 'BLACKSMITH_MOCHA_COMMIT'
/** Set while the CLI asks Mocha for its options, so the `.mocharc` helper does not select again. */
export const ENV_IN_CLI = 'BLACKSMITH_MOCHA_CLI'

/** Under `node_modules`, like other tools' caches: git ignores it and the recorder never records it. */
export function dataDir(cwd: string): string {
	return (
		process.env[ENV_DIR] ??
		path.join(cwd, 'node_modules', '.cache', 'blacksmith-mocha')
	)
}

export interface Shard {
	index: number
	count: number
}

export const suffix = (shard: Shard | null): string =>
	shard ? `.${shard.index}of${shard.count}` : ''
