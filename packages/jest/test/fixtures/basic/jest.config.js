const testMatch = require('./config-helper')
const { withBlacksmith } = require(process.env.BLACKSMITH_JEST_ENTRY)

module.exports = withBlacksmith(
	{
		watchman: false,
		globalSetup: '<rootDir>/global-setup.js',
		testMatch,
	},
	{ dependencies: { 'test/c.test.js': 'db/*.sql' } },
)
