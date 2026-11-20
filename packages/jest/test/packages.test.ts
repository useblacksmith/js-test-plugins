import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { PackageLinks, packageVersion } from '../../shared/src/packages.ts'

/** A pnpm layout: every version of `pkg` in a store entry of its own. */
function store(): { repo: string; link: (from: string, version: string) => void } {
	const repo = mkdtempSync(path.join(os.tmpdir(), 'packages-'))
	for (const version of ['1.0.0', '1.1.0']) {
		const dir = path.join(repo, 'node_modules/.pnpm', `pkg@${version}`, 'node_modules/pkg')
		mkdirSync(dir, { recursive: true })
		writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }))
	}
	return {
		repo,
		link(from, version) {
			const at = path.join(repo, from, 'node_modules/pkg')
			mkdirSync(path.dirname(at), { recursive: true })
			rmSync(at, { force: true })
			symlinkSync(
				path.join(repo, 'node_modules/.pnpm', `pkg@${version}`, 'node_modules/pkg'),
				at,
			)
		},
	}
}

test('a test depends on the links that led to its packages, and a link made to lead elsewhere is another package', () => {
	const { repo, link } = store()
	link('packages/a', '1.0.0')
	link('packages/b', '1.1.0')
	const loaded = 'node_modules/.pnpm/pkg@1.0.0/node_modules/pkg'
	const deps = new PackageLinks(repo).expand([loaded, 'packages/a/src/a.js'])
	assert.deepEqual(deps, [
		loaded,
		'packages/a/node_modules/pkg',
		'packages/a/src/a.js',
	])
	const at = path.join(repo, 'packages/a/node_modules/pkg')
	const before = packageVersion(at)
	// Both versions are installed before and after: only the link moves.
	link('packages/a', '1.1.0')
	assert.notEqual(packageVersion(at), before)
	link('packages/a', '1.0.0')
	assert.equal(packageVersion(at), before)
})

test('packages outside a pnpm store gain no links', () => {
	const { repo } = store()
	assert.deepEqual(
		new PackageLinks(repo).expand(['node_modules/pkg', 'src/a.js']),
		['node_modules/pkg', 'src/a.js'],
	)
})
