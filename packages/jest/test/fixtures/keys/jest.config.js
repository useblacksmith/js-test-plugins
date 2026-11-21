const { withBlacksmith } = require(process.env.BLACKSMITH_JEST_ENTRY)

module.exports = withBlacksmith({
	watchman: false,
	testMatch: ['<rootDir>/test/*.test.js'],
	transform: { '\\.js$': '<rootDir>/esm-transformer.js' },
	// Every test file loads the flags, as with a setup file of a large suite.
	setupFiles: ['<rootDir>/setup.js'],
})
