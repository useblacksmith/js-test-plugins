import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { shardFor } from '../../core/src/shard.ts'
import { Repo, mocharc } from './harness.ts'

const SPECS = ['a', 'b', 'c', 'd', 'e', 'f']
const GLOB = 'test/*.test.js'

describe('selection', () => {
	let repo: Repo
	beforeEach(() => {
		repo = new Repo('selection')
		const first = repo.cli('run', '--', GLOB)
		assert.equal(first.status, 0, first.output)
		assert.deepEqual(Repo.ran(first), SPECS)
	})
	after(() => repo.cleanup())

	const run = (...args: string[]) => Repo.ran(repo.cli('run', '--', GLOB, ...args))
	const affected = () => Repo.ran(repo.cli('affected', '--', GLOB))

	test('nothing runs when nothing changed, and Mocha is not started with no files', () => {
		const second = repo.cli('run', '--', GLOB)
		assert.equal(second.status, 0, second.output)
		assert.deepEqual(Repo.ran(second), [])
		assert.match(second.output, /nothing to run/)
	})

	test('an imported module reruns the spec files that import it', () => {
		repo.append('src/b.js', '// edit\n')
		assert.deepEqual(run(), ['b'])
		assert.deepEqual(affected(), [])
	})

	test('a file one test read reruns that spec file', () => {
		repo.append('test/c.fixture.txt', 'more\n')
		const result = repo.cli('run', '--', GLOB)
		assert.deepEqual(Repo.ran(result), ['c'])
		assert.match(result.output, /1 of its tests: changed: test\/c\.fixture\.txt/)
	})

	test('a module required inside a test reruns every spec file that calls it', () => {
		repo.append('src/shared.js', '// edit\n')
		assert.deepEqual(run(), SPECS)
	})

	test('a new spec file runs, and only it', () => {
		repo.write(
			'test/g.test.js',
			"describe('g', () => { it('passes', () => {}) })\n",
		)
		assert.deepEqual(run(), ['g'])
	})

	test('a Mocha config change runs everything', () => {
		repo.write('.mocharc.json', '{}\n')
		assert.deepEqual(run(), SPECS)
	})

	test('a failed test runs again until it passes', () => {
		const passing = repo.read('test/e.test.js')
		repo.write('test/e.test.js', passing.replace("'e'))", "'nope'))"))
		const failed = repo.cli('run', '--', GLOB)
		assert.equal(failed.status, 1, failed.output)
		assert.deepEqual(affected(), ['e'])
		assert.match(repo.cli('affected', '--', GLOB).output, /failed last time/)
		repo.write('test/e.test.js', passing)
		assert.deepEqual(run(), ['e'])
		assert.deepEqual(affected(), [])
	})
})

test('an option the command does not know is refused', () => {
	const repo = new Repo('selection')
	try {
		const result = repo.cli('run', '--shadow', '--', GLOB)
		assert.equal(result.status, 2)
		assert.match(result.output, /unknown option for run: --shadow/)
		assert.deepEqual(Repo.ran(result), [])
	} finally {
		repo.cleanup()
	}
})

describe('files run in part with --grep', () => {
	let repo: Repo
	beforeEach(() => {
		repo = new Repo('selection')
	})
	after(() => repo.cleanup())

	const run = (...args: string[]) => repo.cli('run', ...args, '--', GLOB)
	const affected = () => Repo.ran(repo.cli('affected', '--', GLOB))

	test('a spec file stays affected until every test in it has a record', () => {
		assert.match(run('--', '--grep', 'first').output, /6 of 18 test\(s\) vouched for/)
		assert.deepEqual(affected(), SPECS)
		assert.match(repo.cli('affected', '--', GLOB).output, /2 of its tests: never ran/)
		assert.match(run('--', '--grep', 'second|third').output, /18 of 18 test\(s\)/)
		assert.deepEqual(affected(), [])
	})

	test('a change drops the record of a test the next run leaves out', () => {
		run()
		repo.append('test/d.fixture.txt', 'more\n')
		// `second` read the fixture; this run only executes `first`.
		assert.match(run('--', '--grep', 'first').output, /17 of 18 test\(s\)/)
		assert.deepEqual(affected(), ['d'])
	})

	test('a Mocha config change drops the record of every test the next run leaves out', () => {
		run()
		repo.write('.mocharc.json', '{ "color": false }\n')
		assert.match(run('--', '--grep', 'first').output, /6 of 18 test\(s\)/)
		assert.deepEqual(affected(), SPECS)
	})

	test('shards that each ran part of a file merge into one record', () => {
		run()
		repo.append('src/shared.js', '// edit\n')
		const shard = (name: string, grep: string) => {
			repo.env.BLACKSMITH_MOCHA_RUN = path.join(repo.cwd, 'node_modules', name)
			run('--no-commit', '--', '--grep', grep)
			delete repo.env.BLACKSMITH_MOCHA_RUN
		}
		shard('a.json', 'first|second')
		shard('b.json', 'third')
		repo.cli('commit', 'node_modules/a.json')
		// The other shard's record has not arrived: its tests stay affected.
		assert.deepEqual(affected(), SPECS)
		repo.cli('commit', 'node_modules/a.json', 'node_modules/b.json')
		assert.deepEqual(affected(), [])
	})
})

describe('shards', () => {
	let repo: Repo
	before(() => {
		repo = new Repo('selection')
	})
	after(() => repo.cleanup())

	const owned = (index: number) =>
		(
			JSON.parse(
				repo.cli('affected', '--shard', `${index}/3`, '--json', '--', GLOB).stdout,
			) as { owned: string[] }
		).owned

	test('a spec file keeps its shard when files are added, and only the owning shard reruns it', () => {
		const before = [1, 2, 3].map(owned)
		assert.deepEqual(before.flat().sort(), SPECS.map((s) => `test/${s}.test.js`))
		for (const index of [1, 2, 3]) {
			repo.cli('run', '--shard', `${index}/3`, '--', GLOB)
		}
		repo.append('src/a.js', '// edit\n')
		repo.write('test/h.test.js', "describe('h', () => { it('passes', () => {}) })\n")
		for (const index of [1, 2, 3]) {
			const mine = owned(index)
			assert.deepEqual(
				mine.filter((spec) => spec !== 'test/h.test.js'),
				before[index - 1],
			)
			const expected = ['a', 'h'].filter(
				(name) => shardFor(`test/${name}.test.js`, 3) === index - 1,
			)
			const result = repo.cli('run', '--shard', `${index}/3`, '--', GLOB)
			assert.deepEqual(Repo.ran(result), expected)
		}
	})
})

describe('.mocharc.cjs', () => {
	let repo: Repo
	before(() => {
		repo = new Repo('selection')
		repo.write(
			'.mocharc.cjs',
			`module.exports = require(${JSON.stringify(mocharc)})({ spec: ['${GLOB}'] })\n`,
		)
	})
	after(() => repo.cleanup())

	for (const args of [[], ['--parallel', '--jobs', '2']]) {
		test(`a plain mocha ${args.join(' ')} command selects, records and passes with nothing to run`, () => {
			repo.append('src/shared.js', '// edit\n')
			const first = repo.mocha(...args)
			assert.equal(first.status, 0, first.output)
			assert.match(first.output, /6 of 6 spec file\(s\) affected/)
			assert.match(first.output, /18 passing/)
			const second = repo.mocha(...args)
			assert.equal(second.status, 0, second.output)
			assert.match(second.output, /0 of 6 spec file\(s\) affected/)
			assert.match(second.output, /0 passing/)
			repo.append('src/f.js', '// edit\n')
			const third = repo.mocha(...args)
			assert.match(third.output, /1 of 6 spec file\(s\) affected/)
			assert.match(third.output, /3 passing/)
		})
	}
})

describe('compiled output that git ignores', () => {
	let repo: Repo
	before(() => {
		repo = new Repo('selection')
		repo.write('dist/lib.js', 'module.exports = 1\n')
		repo.write(
			'dist/x.test.js',
			"const lib = require('./lib')\ndescribe('x', () => { it('passes', () => { if (lib !== 1) throw new Error() }) })\n",
		)
	})
	after(() => repo.cleanup())

	test('is anchored by content: a rebuild with the same output runs nothing, a changed file reruns its specs', () => {
		const run = () => Repo.ran(repo.cli('run', '--', 'dist/*.test.js'))
		assert.deepEqual(run(), ['x'])
		repo.write('dist/lib.js', 'module.exports = 1\n')
		assert.deepEqual(run(), [])
		repo.write('dist/lib.js', 'module.exports = 1 // rebuilt\n')
		assert.deepEqual(run(), ['x'])
	})
})

describe('services', () => {
	let repo: Repo
	let services: ChildProcess
	before(async () => {
		repo = new Repo('services')
		services = spawn(process.execPath, ['services.cjs'], {
			cwd: repo.cwd,
			stdio: ['ignore', 'pipe', 'inherit'],
		})
		await once(services.stdout!, 'data')
		const first = repo.cli('run', '--', GLOB)
		assert.equal(first.status, 0, first.output)
	})
	after(() => {
		services.kill()
		repo.cleanup()
	})

	const run = () => Repo.ran(repo.cli('run', '--', GLOB))

	test('a test is recorded with the endpoints it talked to, over a new or a pooled connection', () => {
		const records = JSON.parse(
			repo.read('node_modules/.cache/blacksmith-mocha/records.json'),
		) as { files: Record<string, { tests: Record<string, { endpoints: string[] }> }> }
		const endpoints = (spec: string) =>
			Object.values(records.files[`test/${spec}.test.js`]?.tests ?? {}).map(
				(entry) => entry.endpoints.join(),
			)
		assert.deepEqual(endpoints('db1'), ['localhost:5432'])
		assert.deepEqual(endpoints('db2'), ['localhost:5432', ''])
		assert.deepEqual(endpoints('api'), ['localhost:4010', 'localhost:4010'])
		assert.deepEqual(endpoints('pure'), [''])
	})

	test('files mapped to an endpoint rerun the spec files that talked to it', () => {
		repo.write('db/migrations/002.sql', 'alter table t add c int;\n')
		assert.deepEqual(run(), ['db1', 'db2'])
		repo.write('mocks/routes.json', '{"/users":[{"id":1}],"/other":1}\n')
		assert.deepEqual(run(), ['api'])
	})

	test('a dependencies rule reruns the spec files it names', () => {
		repo.append('docker/Dockerfile', '# edit\n')
		assert.deepEqual(run(), ['legacy'])
		assert.deepEqual(run(), [])
	})
})

/** In-memory stand-in for the Actions cache service's twirp API plus its blob URLs. */
async function fakeCacheService(): Promise<{
	server: Server
	url: string
	keys: () => string[]
}> {
	const entries = new Map<string, { blob?: Buffer; final: boolean }>()
	let port = 0
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			const body = Buffer.concat(chunks)
			const url = new URL(req.url ?? '/', 'http://x')
			const json = (payload: unknown) => {
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify(payload))
			}
			const blobUrl = (key: string) =>
				`http://127.0.0.1:${port}/blob/${encodeURIComponent(key)}`
			if (url.pathname.startsWith('/blob/')) {
				const key = decodeURIComponent(url.pathname.slice('/blob/'.length))
				if (req.method === 'PUT') {
					entries.set(key, { blob: body, final: false })
					res.writeHead(201).end()
				} else res.writeHead(200).end(entries.get(key)?.blob)
				return
			}
			const request = JSON.parse(body.toString('utf8')) as {
				key: string
				restore_keys?: string[]
			}
			const method = url.pathname.split('/').pop()
			if (method === 'GetCacheEntryDownloadURL') {
				const final = [...entries].filter(([, e]) => e.final).map(([k]) => k)
				const match =
					final.find((k) => k === request.key) ??
					final
						.reverse()
						.find((k) => request.restore_keys?.some((p) => k.startsWith(p)))
				return json(
					match
						? { ok: true, signed_download_url: blobUrl(match), matched_key: match }
						: { ok: false },
				)
			}
			if (method === 'CreateCacheEntry') {
				return json(
					entries.get(request.key)?.final
						? { ok: false }
						: { ok: true, signed_upload_url: blobUrl(request.key) },
				)
			}
			const entry = entries.get(request.key)
			if (entry) entry.final = true
			json({ ok: entry !== undefined })
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	port = (server.address() as { port: number }).port
	return {
		server,
		url: `http://127.0.0.1:${port}/`,
		keys: () => [...entries.keys()],
	}
}

describe('Actions cache', () => {
	let repo: Repo
	let cache: Awaited<ReturnType<typeof fakeCacheService>>
	before(async () => {
		repo = new Repo('selection')
		cache = await fakeCacheService()
		repo.env.ACTIONS_RESULTS_URL = cache.url
	})
	after(() => {
		cache.server.close()
		repo.cleanup()
	})

	// The fake runs in this process, so the CLI must not block it: spawn, don't spawnSync.
	const cli = async (...args: string[]) => {
		const child = spawn(
			process.execPath,
			[path.join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args],
			{ cwd: repo.cwd, env: repo.environment() },
		)
		let output = ''
		child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
		child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
		await once(child, 'exit')
		return output
	}

	test('a run saves its record, and a fresh checkout restores it and runs only what changed', async () => {
		const first = await cli('run', '--', GLOB)
		assert.match(first, /no dependency cache/)
		assert.match(first, /saved dependency cache blacksmith-mocha-/)
		assert.equal(cache.keys().length, 1)
		// A new job: nothing on disk but the checkout.
		repo.git('clean', '-qfdx', '-e', 'node_modules/mocha')
		repo.append('src/b.js', '// edit\n')
		repo.git('commit', '-qam', 'edit')
		const second = await cli('run', '--', GLOB)
		assert.match(second, /restored dependency cache blacksmith-mocha-/)
		assert.match(second, /1 of 6 spec file\(s\) affected; changed: src\/b\.js/)
		assert.equal(cache.keys().length, 2)
	})

	test('affected --json prints the JSON alone on stdout when it restores', async () => {
		repo.git('clean', '-qfdx', '-e', 'node_modules/mocha')
		const child = spawn(
			process.execPath,
			[path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'affected', '--json', '--', GLOB],
			{ cwd: repo.cwd, env: repo.environment(), stdio: ['ignore', 'pipe', 'pipe'] },
		)
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
		await once(child, 'exit')
		assert.match(stderr, /restored dependency cache/)
		assert.deepEqual(
			(JSON.parse(stdout) as { owned: string[] }).owned.length,
			6,
		)
	})

	test('a run after `affected` in the same job restores again and reruns nothing', async () => {
		repo.git('clean', '-qfdx', '-e', 'node_modules/mocha')
		assert.match(await cli('affected', '--', GLOB), /0 of 6 spec file\(s\) affected/)
		const output = await cli('run', '--', GLOB)
		assert.match(output, /restored dependency cache/)
		assert.match(output, /0 of 6 spec file\(s\) affected/)
	})

	test('a job whose cache is read-only restores and does not save', async () => {
		repo.git('clean', '-qfdx', '-e', 'node_modules/mocha')
		repo.env.ACTIONS_CACHE_MODE = 'read'
		const output = await cli('run', '--', GLOB)
		assert.match(output, /restored dependency cache/)
		assert.match(output, /0 of 6 spec file\(s\) affected/)
		assert.match(output, /not saved: the Actions cache is read-only/)
	})
})
