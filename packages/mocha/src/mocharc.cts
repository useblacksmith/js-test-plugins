// Loaded from a `.mocharc.cjs`, which Mocha reads with `require()`:
//
//   module.exports = require('@useblacksmith/mocha/mocharc')({ spec: ['test/**/*.test.js'] })
//
// Returns the config with the recorder preloaded and every unaffected spec
// file ignored. The selection is asynchronous (git, the Actions cache), so it
// runs in a child process.
const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
const nodePath = require('node:path') as typeof import('node:path')

type MochaConfig = Record<string, unknown> & {
	require?: string | string[]
	ignore?: string | string[]
	spec?: string | string[]
}

function blacksmith(user: MochaConfig = {}): MochaConfig {
	// The CLI asks Mocha for its options to list the spec files, which loads
	// the config again; so does every `--parallel` worker.
	if (
		process.env.BLACKSMITH_MOCHA_CLI === '1' ||
		process.env.BLACKSMITH_RECORD_ROOT !== undefined
	) {
		return user
	}
	const extension = __filename.endsWith('.cts') ? 'ts' : 'js'
	const shard = process.env.BLACKSMITH_MOCHA_SHARD
	const pending = JSON.parse(
		execFileSync(
			process.execPath,
			[
				nodePath.join(__dirname, `cli.${extension}`),
				'affected',
				'--json',
				...(shard ? ['--shard', shard] : []),
				'--',
				...process.argv.slice(2),
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
		),
	) as {
		all: string[]
		owned: string[]
		selection: Record<string, { run: boolean }>
	}
	const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
		encoding: 'utf8',
	}).trim()
	const owned = new Set(pending.owned)
	const skip = pending.all.filter(
		(spec) => !owned.has(spec) || !pending.selection[spec]?.run,
	)
	console.log(
		`[blacksmith] ${pending.all.length - skip.length} of ${pending.all.length} spec file(s) affected`,
	)
	process.env.BLACKSMITH_MOCHA_COMMIT = '1'
	const config: MochaConfig = {
		...user,
		require: [
			nodePath.join(__dirname, `register.${extension}`),
			...[user.require ?? []].flat(),
		],
		ignore: [
			...[user.ignore ?? []].flat(),
			...skip.map((spec) =>
				nodePath.relative(process.cwd(), nodePath.join(repo, spec)),
			),
		],
	}
	// Mocha exits 1 with "No test files found" when every spec is ignored; a
	// spec file with no tests in it makes that a passing run.
	if (skip.length === pending.all.length) {
		config.spec = [
			nodePath.join(__dirname, extension === 'ts' ? 'empty.spec.cts' : 'empty.spec.cjs'),
		]
	}
	return config
}

module.exports = blacksmith
