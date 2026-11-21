// A small ES-module-to-CommonJS transformer, enough for this fixture.
const names = (list) =>
	list
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => part.split(/\s+as\s+/))

module.exports = {
	process(source) {
		const tail = []
		const code = source
			.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+(['"].*?['"])/gm, 'const $1 = require($2)')
			.replace(/^import\s+\{([^}]*)\}\s+from\s+(['"].*?['"])/gm, (_, list, from) =>
				`const {${names(list).map(([a, b]) => (b ? `${a}: ${b}` : a)).join(', ')}} = require(${from})`,
			)
			.replace(/^import\s+(['"].*?['"])/gm, 'require($1)')
			.replace(/^export\s+\*\s+from\s+(['"].*?['"])/gm, 'Object.assign(exports, require($1))')
			.replace(/^export\s+\{([^}]*)\}\s+from\s+(['"].*?['"])/gm, (_, list, from) =>
				`{ const from = require(${from}); ${names(list)
					.map(
						([a, b]) =>
							`Object.defineProperty(exports, '${b ?? a}', { enumerable: true, get: () => from.${a} })`,
					)
					.join(';')} }`,
			)
			.replace(/^export\s+(async\s+function|function|const|let|class)\s+(\w+)/gm, (_, kind, name) => {
				tail.push(`exports.${name} = ${name}`)
				return `${kind} ${name}`
			})
		return { code: `${code}\n${tail.join('\n')}` }
	},
}
