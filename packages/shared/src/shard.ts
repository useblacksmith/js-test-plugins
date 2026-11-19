import { createHash } from 'node:crypto'
import path from 'node:path'

/** Zero-based shard owning `relativePath`; depends only on the path and `count`, never on the other test files. */
export function shardFor(relativePath: string, count: number): number {
	const digest = createHash('sha1')
		.update(relativePath.split(path.sep).join('/'))
		.digest()
	return digest.readUInt32BE(0) % count
}
