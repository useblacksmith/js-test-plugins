import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * The Actions cache service's twirp API at ACTIONS_RESULTS_URL, as the
 * plugins use it: one gzipped JSON bundle of small text files per key. On a
 * Blacksmith runner a plain step can reach it with no token because the VM
 * proxy adds one; elsewhere the variable is absent and nothing happens.
 */

export const ENV_CACHE_URL = 'ACTIONS_RESULTS_URL'
const TWIRP = 'twirp/github.actions.results.api.v1.CacheService/'
export const TIMEOUT_MS = 15_000

export interface CacheKey {
	/** Exact key for this tree; also the save key. */
	key: string
	/** Prefix shared by every entry the run may restore from: the newest one restores. */
	prefix: string
}

/** What tells one plugin's bundles from another's. */
export interface BundleFormat {
	/** Bundle format; bumped when its shape changes so old entries are missed, not misread. */
	version: string
	userAgent: string
	/** Whether the file `name` of the cache directory travels in the bundle. */
	travels(name: string): boolean
}

interface Bundle {
	version: string
	files: Record<string, string>
}

async function twirp<T>(
	base: string,
	userAgent: string,
	method: string,
	body: object,
): Promise<T> {
	const response = await fetch(new URL(TWIRP + method, base), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'user-agent': userAgent,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	})
	if (!response.ok) throw new TwirpError(method, response.status)
	return (await response.json()) as T
}

export class TwirpError extends Error {
	readonly status: number
	constructor(method: string, status: number) {
		super(`${method} ${status}`)
		this.status = status
	}
}

/**
 * The job's Actions cache mode as the runner exports it: `read` and `none`
 * refuse a save, `write-only` and `none` refuse a restore. Unset on runners
 * that do not export it.
 */
export function cacheMode(): { readable: boolean; writable: boolean } {
	const mode = (process.env.ACTIONS_CACHE_MODE ?? '').trim().toLowerCase()
	return {
		readable: mode !== 'none' && mode !== 'write-only',
		writable: mode !== 'none' && mode !== 'read',
	}
}

const ALREADY_SAVED = (key: string) =>
	`an earlier run already saved ${key} for this commit`
const READ_ONLY = 'the Actions cache is read-only for this job'

/**
 * Requests carry both casings: a twirp JSON server accepts proto field names
 * (`restore_keys`, `size_bytes` as an integer) and their lowerCamel aliases;
 * the Blacksmith cache service validates the former and answers in it.
 */
function field(
	record: Record<string, unknown>,
	snake: string,
	camel: string,
): unknown {
	return record[snake] ?? record[camel]
}

export type RestoreOutcome =
	| { restored: true; key: string; files: number }
	| { restored: false; reason: string }

/** Fetches the newest bundle under `prefix` (exact `key` first) into `cacheDir`. */
export async function restoreBundle(
	base: string,
	cacheDir: string,
	{ key, prefix }: CacheKey,
	format: BundleFormat,
): Promise<RestoreOutcome> {
	const lookup = await twirp<Record<string, unknown>>(
		base,
		format.userAgent,
		'GetCacheEntryDownloadURL',
		{
			key,
			restore_keys: [prefix],
			restoreKeys: [prefix],
			version: format.version,
		},
	)
	const url = field(lookup, 'signed_download_url', 'signedDownloadUrl')
	if (!lookup.ok || typeof url !== 'string' || url === '') {
		return { restored: false, reason: `no entry under ${prefix}` }
	}
	const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
	if (!response.ok) throw new Error(`download ${response.status}`)
	const bundle = JSON.parse(
		gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'),
	) as Bundle
	if (bundle.version !== format.version) {
		return { restored: false, reason: `bundle version ${bundle.version}` }
	}
	await mkdir(cacheDir, { recursive: true })
	for (const [name, content] of Object.entries(bundle.files)) {
		if (!format.travels(name)) continue
		await writeFile(path.join(cacheDir, name), content)
	}
	const matched = field(lookup, 'matched_key', 'matchedKey')
	return {
		restored: true,
		key: typeof matched === 'string' && matched !== '' ? matched : key,
		files: Object.keys(bundle.files).length,
	}
}

export type SaveOutcome =
	{ saved: true; bytes: number } | { saved: false; reason: string }

/** Uploads the files that travel under the exact `key`; an existing entry for that key is left alone. */
export async function saveBundle(
	base: string,
	cacheDir: string,
	{ key }: CacheKey,
	format: BundleFormat,
): Promise<SaveOutcome> {
	if (!cacheMode().writable) return { saved: false, reason: READ_ONLY }
	const files: Record<string, string> = {}
	for (const name of await readdir(cacheDir)) {
		if (format.travels(name))
			files[name] = await readFile(path.join(cacheDir, name), 'utf8')
	}
	const body = gzipSync(
		JSON.stringify({ version: format.version, files } satisfies Bundle),
	)
	let reserve: Record<string, unknown>
	try {
		reserve = await twirp<Record<string, unknown>>(
			base,
			format.userAgent,
			'CreateCacheEntry',
			{
				key,
				version: format.version,
			},
		)
	} catch (error) {
		if (error instanceof TwirpError && error.status === 409)
			return { saved: false, reason: ALREADY_SAVED(key) }
		if (error instanceof TwirpError && error.status === 403)
			return { saved: false, reason: READ_ONLY }
		throw error
	}
	const url = field(reserve, 'signed_upload_url', 'signedUploadUrl')
	if (!reserve.ok || typeof url !== 'string' || url === '') {
		return { saved: false, reason: ALREADY_SAVED(key) }
	}
	const put = await fetch(url, {
		method: 'PUT',
		headers: {
			'x-ms-blob-type': 'BlockBlob',
			'content-type': 'application/octet-stream',
		},
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS * 4),
	})
	if (!put.ok) throw new Error(`upload ${put.status}`)
	const done = await twirp<Record<string, unknown>>(
		base,
		format.userAgent,
		'FinalizeCacheEntryUpload',
		{
			key,
			version: format.version,
			size_bytes: body.byteLength,
			sizeBytes: String(body.byteLength),
		},
	)
	if (!done.ok) return { saved: false, reason: `finalize refused ${key}` }
	return { saved: true, bytes: body.byteLength }
}
