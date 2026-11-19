const fs = require('node:fs')
const { parentPort } = require('node:worker_threads')
parentPort.postMessage(fs.readFileSync(require('node:path').join(__dirname, '../data/worker.txt'), 'utf8'))
