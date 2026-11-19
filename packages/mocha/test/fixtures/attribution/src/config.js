const fs = require('node:fs')
const path = require('node:path')
let cached
// Read on the first call in the process, memoized for every later spec file.
exports.getConfig = () => (cached ??= JSON.parse(fs.readFileSync(path.join(__dirname, '../data/config.json'), 'utf8')))
