const fs = require('node:fs')
require('./child-dep.js')
process.stdout.write(fs.readFileSync(require('node:path').join(__dirname, '../data/child.txt'), 'utf8'))
