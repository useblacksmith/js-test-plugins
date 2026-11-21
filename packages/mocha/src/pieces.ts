import type { RunFile, RunRecord } from '../../core/src/record.ts'

/** What one process of a run (Mocha's main process, or a `--parallel` worker) recorded, written once per `Runner`. */
export interface Piece {
	at: number
	graph: Record<string, string[]>
	/** Files Mocha loaded itself: spec files and `--require` files. */
	entries: string[]
	/** Files read with no repository module on the stack and no test running. */
	unattributed: string[]
	files: Record<string, RunFile>
	/** Reads of a test of an earlier spec file that arrived after its `Runner` ended. */
	late: Record<string, Record<string, string[]>>
}

/** Unions the pieces of one run into its record. */
export function unionPieces(pieces: Piece[]): RunRecord {
	const graph: Record<string, string[]> = {}
	const entries = new Set<string>()
	const unattributed = new Set<string>()
	const files: Record<string, RunFile> = {}
	for (const piece of pieces) {
		for (const [from, to] of Object.entries(piece.graph)) {
			graph[from] = [...new Set([...(graph[from] ?? []), ...to])].sort()
		}
		for (const entry of piece.entries) entries.add(entry)
		for (const file of piece.unattributed) unattributed.add(file)
		Object.assign(files, piece.files)
	}
	for (const piece of pieces) {
		for (const [spec, tests] of Object.entries(piece.late)) {
			for (const [title, deps] of Object.entries(tests)) {
				const test = files[spec]?.tests[title]
				if (test) test.deps = [...new Set([...(test.deps ?? []), ...deps])].sort()
			}
		}
	}
	// Roots that are not spec files are `--require` files: every spec depends on them.
	const global = [
		...new Set([
			...[...entries].filter((entry) => !(entry in files)),
			...unattributed,
		]),
	].sort()
	return { at: Date.now(), graph, global, files }
}
