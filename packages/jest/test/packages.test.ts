import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { packageVersion } from '../../shared/src/packages.ts'

function copy(store: string, entry: string, version: string): string {
	const dir = path.join(store, entry, 'node_modules', 'pkg')
	mkdirSync(dir, { recursive: true })
	writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }))
	return dir
}

test('a second copy of a package in the pnpm store changes what stands for the first', () => {
	const store = path.join(
		mkdtempSync(path.join(os.tmpdir(), 'packages-')),
		'node_modules',
		'.pnpm',
	)
	const first = copy(store, 'pkg@1.0.0', '1.0.0')
	const before = packageVersion(first)
	copy(store, 'pkg-other@1.0.0', '1.0.0')
	assert.equal(packageVersion(first), before)
	copy(store, 'pkg@1.1.0', '1.1.0')
	assert.notEqual(packageVersion(first), before)
})
