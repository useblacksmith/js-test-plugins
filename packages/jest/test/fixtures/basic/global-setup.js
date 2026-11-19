const port = require('./src/setup-dep')

module.exports = async () => {
	process.env.FIXTURE_PORT = String(port)
}
