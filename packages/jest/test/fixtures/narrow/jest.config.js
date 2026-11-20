const { withBlacksmith } = require(process.env.BLACKSMITH_JEST_ENTRY)

module.exports = withBlacksmith(
	{
		watchman: false,
		testMatch: ['<rootDir>/test/*.test.js'],
		transform: { '\\.js$': '<rootDir>/esm-transformer.js' },
		moduleNameMapper: { '^@src/(.*)$': '<rootDir>/src/$1' },
	},
	{ narrow: process.env.NARROW !== '0' },
)
