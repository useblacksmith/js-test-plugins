const { execFileSync } = require('node:child_process')
const path = require('node:path')

test('child', () => {
	const out = execFileSync(process.execPath, [path.join(__dirname, '../src/child.js')], {
		encoding: 'utf8',
	})
	expect(out.trim()).toBe('hello')
})
