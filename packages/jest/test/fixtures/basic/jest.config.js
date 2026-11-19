const { withBlacksmith } = require(process.env.BLACKSMITH_JEST_ENTRY)

module.exports = withBlacksmith(
	{
		watchman: false,
		globalSetup: '<rootDir>/global-setup.js',
		testMatch: ['<rootDir>/test/*.test.js'],
	},
	{ dependencies: { 'test/c.test.js': 'db/*.sql' } },
)
