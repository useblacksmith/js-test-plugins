const fs = require('node:fs')
const path = require('node:path')

test('a imports', () => {
	expect(require('../src/a')).toBe(2)
})

test('a reads', () => {
	const data = JSON.parse(
		fs.readFileSync(path.join(__dirname, '../src/data.json'), 'utf8'),
	)
	expect(data.v).toBe(1)
})
