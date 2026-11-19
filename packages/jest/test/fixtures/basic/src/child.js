const fs = require('node:fs')
const path = require('node:path')

process.stdout.write(fs.readFileSync(path.join(__dirname, 'child-data.txt'), 'utf8'))
