import {
	type ResolvedConfig,
	type TestSpecification,
	type Vitest,
} from 'vitest/node'

const BRAND = Symbol.for('blacksmith.vitest.sequencer')
const WRAPPED = Symbol.for('blacksmith.vitest.sequencer.wrapped')

type SequencerClass = ResolvedConfig['sequence']['sequencer']

/** Whether the configured sequencer is already the wrapper `stableShards` makes, of this or another copy of the module. */
export function isStable(sequencer: unknown): boolean {
	return (
		typeof sequencer === 'function' &&
		(sequencer as { [BRAND]?: boolean })[BRAND] === true
	)
}

/**
 * Vitest hands `shard()` the specs `--changed` kept, so a sequencer that
 * slices by position moves tests between shards as the selection changes,
 * and a test two shards disagree about can run on neither. The wrapper takes
 * the sequencer's own assignment over the full test list, as on a full run,
 * and keeps it whatever the selection; `sort()` stays the sequencer's.
 */
export function stableShards(Theirs: SequencerClass): SequencerClass {
	return class extends Theirs {
		static readonly [BRAND] = true
		static readonly [WRAPPED] = Theirs
		readonly #vitest: Vitest
		constructor(vitest: Vitest) {
			super(vitest)
			this.#vitest = vitest
		}
		override shard = async (
			files: TestSpecification[],
		): Promise<TestSpecification[]> => {
			const owns = await shardOwner(this.#vitest)
			return files.filter((file) => owns(file.moduleId))
		}
	}
}

/**
 * Which tests this shard runs, independent of the selection: by the
 * sequencer's own `shard()`, Vitest's or the config's, over the full test
 * list.
 */
export async function shardOwner(
	vitest: Vitest,
): Promise<(moduleId: string) => boolean> {
	if (!vitest.config.shard) return () => true
	const configured = vitest.config.sequence.sequencer
	const Theirs =
		(configured as { [WRAPPED]?: SequencerClass })[WRAPPED] ?? configured
	const owned = new Set(
		(await new Theirs(vitest).shard(await vitest.globTestSpecifications())).map(
			(specification) => specification.moduleId,
		),
	)
	return (moduleId) => owned.has(moduleId)
}
