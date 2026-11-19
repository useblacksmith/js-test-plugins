const assert = require('node:assert')
const http = require('node:http')
describe('api', () => {
	it('calls the mock service with fetch', async () => {
		assert.deepEqual(await (await fetch('http://127.0.0.1:4010/users')).json(), [{ id: 1 }])
	})
	it('calls the mock service with http.get', (done) => {
		http.get('http://localhost:4010/users', { agent: false }, (response) => response.resume().on('end', done))
	})
})
