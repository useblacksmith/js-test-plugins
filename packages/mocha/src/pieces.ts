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
	/** Per spec file, module → the functions of it the file's tests and hooks entered; only modules whose marks ran. Absent when the process did not mark modules. */
	ran?: Record<string, Record<string, string[]>>
	/** Spec files that loaded a module read as text or run by a child process, which has no entry in `ran`. */
	whole?: string[]
	/** What a test of an earlier spec file entered after its `Runner` ended. */
	lateRan?: Record<string, Record<string, string[]>>
}

/** A run's record with what each spec file entered, when every process of the run marked modules. */
export interface MochaRun extends RunRecord {
	ran?: Record<string, Record<string, string[]>>
	/** Spec files with a module that is deliberately left out of `ran`. */
	whole?: string[]
}

/** Unions the pieces of one run into its record. */
export function unionPieces(pieces: Piece[]): MochaRun {
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
	let ran: MochaRun['ran']
	if (pieces.length > 0 && pieces.every((piece) => piece.ran)) {
		ran = {}
		for (const piece of pieces) Object.assign(ran, piece.ran)
		for (const piece of pieces) {
			for (const [spec, modules] of Object.entries(piece.lateRan ?? {})) {
				for (const [module, names] of Object.entries(modules)) {
					// A module the spec file has no entry for stays without one: every change to it reruns the file.
					const entered = ran[spec]?.[module]
					if (entered) ran[spec]![module] = [...new Set([...entered, ...names])].sort()
				}
			}
		}
	}
	const whole = pieces.flatMap((piece) => piece.whole ?? [])
	return {
		at: Date.now(),
		graph,
		global,
		files,
		...(ran ? { ran, ...(whole.length > 0 ? { whole } : {}) } : {}),
	}
}
