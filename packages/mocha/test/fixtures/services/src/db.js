const net = require('node:net')
let connection
// One pooled connection for the whole process: opened by the first spec that queries.
exports.query = (sql) =>
	new Promise((resolve, reject) => {
		connection ??= net.connect(5432, '127.0.0.1')
		connection.once('data', (data) => resolve(String(data)))
		connection.once('error', reject)
		connection.write(sql)
	})
exports.close = () => connection?.destroy()
