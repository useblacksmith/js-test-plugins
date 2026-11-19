const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Worker } = require('node:worker_threads')
const loadtime = require('../src/loadtime')
const { getConfig } = require('../src/config')
const data = (name) => path.join(__dirname, '../data', name)

describe('b', () => {
	it('reads b.json (slow enough for a.test.js to leak into)', async () => {
		await new Promise((resolve) => setTimeout(resolve, 80))
		assert.equal(JSON.parse(await fs.promises.readFile(data('b.json'), 'utf8')).name, 'b')
	})
	it('uses a value read at load time (module already cached)', () => assert.equal(loadtime.name, 'loadtime'))
	it('uses the memoized config (no read when a.test.js ran first in this process)', () => assert.equal(getConfig().name, 'config'))
	it('runs a worker thread', async () => {
		const worker = new Worker(path.join(__dirname, '../scripts/worker.js'))
		const [message] = await require('node:events').once(worker, 'message')
		assert.equal(message, 'worker\n')
		await worker.terminate()
	})
	it('runs an async node child process', async () => {
		const child = spawn(process.execPath, [path.join(__dirname, '../scripts/child.js')])
		const [code] = await require('node:events').once(child, 'exit')
		assert.equal(code, 0)
	})
})
