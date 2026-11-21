/**
 * The dependency record every plugin keeps, whatever runs the tests. A test
 * file has the files it depends on as a whole and the state of each of its
 * tests; a runner that knows more adds what each test read on its own and an
 * import graph the dependencies are closed over. Paths are
 * repository-relative with `/`.
 */
export const RECORDS_VERSION = 7

export type TestState = 'passed' | 'failed' | 'skipped'

export interface TestRecord {
	state: TestState
	/** Files the test read, or modules it loaded, while it ran: a change reruns the test, not its file's others. */
	deps?: string[]
	/** `host:port` of every socket the test wrote to. */
	endpoints?: string[]
}

export interface FileRecord {
	/** What the test file depends on as a whole: modules it loaded and files it read, itself aside, the directories of the installed packages it loaded, and what its hooks read. */
	deps: string[]
	/** `host:port` of every socket written to outside a test. */
	endpoints?: string[]
	/** Full name of every test in the file, for a runner that knows them all whatever the run filtered: one without a record under `tests` never ran. */
	all?: string[]
	/** Full name of each test that ran → how it ended the last time, and what it read. */
	tests: Record<string, TestRecord>
	/** package.json files among `deps` the test read itself: compared in full, dependency fields included. */
	manifests?: string[]
	/** The file failed outside any test (a syntax error, a failed hook), or nothing vouches for the tests a run left out. */
	failed?: boolean
	/** The packages among `deps` are not all the file loaded (a browser ran it): it reruns with a lockfile too. */
	incomplete?: boolean
	/** When the file last ran, in milliseconds: of the cache entries that hold a record of it, the one with the latest run is used. */
	at?: number
}

/** A test file as one run saw it. */
export interface RunFile extends FileRecord {
	/** The run left some of the file's tests out (a name filter, `.only`) and `all` does not say which. */
	partial?: boolean
}

/** What one run recorded. */
export interface RunRecord {
	at: number
	/** Files every test file depends on: what the runner's own process and its setup loaded. */
	global: string[]
	/** Project name → files every test file of that project depends on (its config, its setup), for a runner with projects; '' is the project of a key that names none. */
	projects?: Record<string, string[]>
	/** importer → imported, for a runner that loads every test file into one process. */
	graph?: Record<string, string[]>
	files: Record<string, RunFile>
}

export interface Records {
	version: number
	at: number
	global: string[]
	projects: Record<string, string[]>
	graph: Record<string, string[]>
	files: Record<string, FileRecord>
}

/**
 * A test file's key in the record: its path, and the project too when the
 * runner has the file in several. A runner shards a test file once per
 * project, so two shards may each run it in a project of their own.
 */
export function specKey(file: string, project?: string): string {
	return project === undefined ? file : `${file}\0${project}`
}

/** The test file a key of the record is for. */
export function specPath(spec: string): string {
	const at = spec.indexOf('\0')
	return at === -1 ? spec : spec.slice(0, at)
}

/** The project a key of the record is for, when it names one. */
export function specProject(spec: string): string | undefined {
	const at = spec.indexOf('\0')
	return at === -1 ? undefined : spec.slice(at + 1)
}

export function emptyRecords(): Records {
	return { version: RECORDS_VERSION, at: 0, global: [], projects: {}, graph: {}, files: {} }
}

type StoredTest = TestState | (Omit<TestRecord, 'deps'> & { deps?: number[] })
type StoredFile = Omit<FileRecord, 'deps' | 'manifests' | 'tests'> & {
	deps: number[]
	manifests?: number[]
	tests: Record<string, StoredTest>
}

/**
 * The record as the file holds it: each path once, and every list of paths
 * as positions in `paths`. Test files load mostly the same modules and
 * packages, so naming them under each made the file several times larger.
 */
export interface StoredRecords {
	version: number
	at: number
	paths: string[]
	global: number[]
	projects?: Record<string, number[]>
	/** `[importer, ...imported]`, each a position. */
	graph: number[][]
	files: Record<string, StoredFile>
}

export function storeRecords(records: Records): StoredRecords {
	const at = new Map<string, number>()
	const paths: string[] = []
	const position = (file: string): number => {
		let found = at.get(file)
		if (found === undefined) {
			found = paths.length
			at.set(file, found)
			paths.push(file)
		}
		return found
	}
	const files: StoredRecords['files'] = {}
	for (const [spec, entry] of Object.entries(records.files)) {
		const { deps, manifests, tests, ...rest } = entry
		const stored: StoredFile = { ...rest, deps: deps.map(position), tests: {} }
		if (manifests) stored.manifests = manifests.map(position)
		for (const [title, test] of Object.entries(tests)) {
			const { deps: read, ...state } = test
			stored.tests[title] =
				read === undefined && test.endpoints === undefined
					? test.state
					: { ...state, ...(read ? { deps: read.map(position) } : {}) }
		}
		files[spec] = stored
	}
	return {
		version: RECORDS_VERSION,
		at: records.at,
		paths,
		global: records.global.map(position),
		projects: Object.fromEntries(
			Object.entries(records.projects).map(([name, files]) => [name, files.map(position)]),
		),
		graph: Object.entries(records.graph).map(([from, to]) => [
			position(from),
			...to.map(position),
		]),
		files,
	}
}

/** The record a file holds, or null when it is not one this version reads. */
export function loadRecords(stored: StoredRecords | null): Records | null {
	if (stored === null || typeof stored !== 'object') return null
	if (stored.version !== RECORDS_VERSION || !Array.isArray(stored.paths)) return null
	try {
		const name = (position: number): string => {
			const file = stored.paths[position]
			if (typeof file !== 'string') throw new Error('not a record')
			return file
		}
		const graph: Records['graph'] = {}
		for (const [from, ...to] of stored.graph) {
			if (from === undefined) throw new Error('not a record')
			graph[name(from)] = to.map(name)
		}
		const files: Records['files'] = {}
		for (const [spec, entry] of Object.entries(stored.files)) {
			const { deps, manifests, tests, ...rest } = entry
			const file: FileRecord = { ...rest, deps: deps.map(name), tests: {} }
			if (manifests) file.manifests = manifests.map(name)
			for (const [title, test] of Object.entries(tests)) {
				if (typeof test === 'string') file.tests[title] = { state: test }
				else {
					const { deps: read, ...state } = test
					file.tests[title] = { ...state, ...(read ? { deps: read.map(name) } : {}) }
				}
			}
			files[spec] = file
		}
		return {
			version: RECORDS_VERSION,
			at: stored.at,
			global: stored.global.map(name),
			projects: Object.fromEntries(
				Object.entries(stored.projects ?? {}).map(([project, files]) => [
					project,
					files.map(name),
				]),
			),
			graph,
			files,
		}
	} catch {
		return null
	}
}

/** Every repository path the record names: what the anchor has to cover. */
export function recordedPaths(records: Records): Set<string> {
	const paths = new Set<string>(records.global)
	for (const files of Object.values(records.projects)) {
		for (const file of files) paths.add(file)
	}
	for (const [from, to] of Object.entries(records.graph)) {
		paths.add(from)
		for (const file of to) paths.add(file)
	}
	for (const [spec, entry] of Object.entries(records.files)) {
		paths.add(specPath(spec))
		for (const file of entry.deps) paths.add(file)
		for (const test of Object.values(entry.tests)) {
			for (const file of test.deps ?? []) paths.add(file)
		}
	}
	return paths
}

/** Every package.json a test file read itself. */
export function readManifests(records: Records): Set<string> {
	return new Set(
		Object.values(records.files).flatMap((entry) => entry.manifests ?? []),
	)
}

/** Whether nothing in the record says the test file has to run again for its own sake. */
export function vouched(entry: FileRecord): boolean {
	if (entry.failed) return false
	if (entry.all?.some((title) => !entry.tests[title])) return false
	return !Object.values(entry.tests).some((test) => test.state === 'failed')
}
