const fs = require('node:fs')
const path = require('node:path')

const port = require('./src/setup-dep')

module.exports = async () => {
	process.env.FIXTURE_PORT = String(port)
	process.env.FIXTURE_SEED = fs.readFileSync(path.join(__dirname, 'db/seed.txt'), 'utf8')
}
