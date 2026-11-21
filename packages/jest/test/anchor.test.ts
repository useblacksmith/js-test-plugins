import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { anchorTree } from '../../core/src/git.ts'

test('a record of thousands of paths anchors as the same paths a few at a time do', async () => {
	const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bsm-anchor-')))
	try {
		const write = (file: string, content: string) => {
			mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
			writeFileSync(path.join(repo, file), content)
		}
		const tracked: string[] = []
		for (let i = 0; i < 2100; i++) {
			const file = `src/d${i % 7}/f${i}.js`
			write(file, `module.exports = ${i}\n`)
			tracked.push(file)
		}
		write('.gitignore', 'generated\n*.local\n')
		const git = (...args: string[]) =>
			execFileSync(
				'git',
				['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
				{ cwd: repo },
			)
		git('init', '-q', '-b', 'main')
		git('add', '-A')
		git('commit', '-q', '-m', 'init')
		write('src/d0/untracked.js', '1\n')
		write('src/d1/env.local', '2\n')
		write('generated/out.js', '3\n')
		// Directories, ignored files that were read, an untracked file and a path that is gone.
		const few = [
			'src',
			'src/d0',
			'src/d1',
			'generated',
			'src/d1/env.local',
			'generated/out.js',
			'src/d0/untracked.js',
			'src/gone.js',
		]
		const all = await anchorTree(repo, [...few, ...tracked])
		assert.equal(Object.keys(all).length, few.length - 1 + tracked.length)
		assert.deepEqual(
			{ ...all },
			{
				...(await anchorTree(repo, few)),
				...(await anchorTree(repo, tracked.slice(0, 1500))),
				...(await anchorTree(repo, tracked.slice(1500))),
			},
		)
	} finally {
		rmSync(repo, { recursive: true, force: true })
	}
})
