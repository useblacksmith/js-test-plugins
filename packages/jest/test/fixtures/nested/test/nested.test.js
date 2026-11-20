const { spawnSync } = require('node:child_process')
const path = require('node:path')

test('a Jest this test starts runs its fixture', () => {
	const root = path.join(__dirname, '..')
	const result = spawnSync(
		process.execPath,
		[path.join(root, 'node_modules/jest/bin/jest.js'), '--runInBand'],
		{ cwd: root, encoding: 'utf8', env: { ...process.env, INNER: '1' } },
	)
	expect(result.stderr).toMatch(/1 passed, 1 total/)
	expect(result.status).toBe(0)
})
