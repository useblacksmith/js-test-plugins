const fs = require('node:fs')
const path = require('node:path')
// Evaluated once per process: the read happens while the first spec that requires this is loading.
fs.appendFileSync(process.env.EVAL_LOG ?? '/dev/null', `${process.pid}\n`)
module.exports = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/loadtime.json'), 'utf8'))
