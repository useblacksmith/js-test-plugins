'use strict'
// Stand-ins for the services a job starts before its tests: a "database" speaking a line protocol on 5432, and an HTTP mock service on 4010.
const net = require('node:net')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
net.createServer((socket) => socket.on('data', (data) => socket.write(`ok ${data}`))).listen(5432, '127.0.0.1')
http
	.createServer((request, response) => {
		const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'mocks/routes.json'), 'utf8'))
		response.end(JSON.stringify(routes[request.url] ?? null))
	})
	.listen(4010, '127.0.0.1', () => console.log('ready'))
