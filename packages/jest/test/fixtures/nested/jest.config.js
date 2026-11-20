const { withBlacksmith } = require(process.env.BLACKSMITH_JEST_ENTRY)

module.exports = withBlacksmith({
	watchman: false,
	testMatch: process.env.INNER ? ['<rootDir>/inner/*.fixture.js'] : ['<rootDir>/test/*.test.js'],
})
