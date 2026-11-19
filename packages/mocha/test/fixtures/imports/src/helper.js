// The require runs the first time a test calls this, and hits the module cache afterwards.
exports.loadLazy = () => require('./lazy').lazy
