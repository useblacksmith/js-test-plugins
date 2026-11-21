import { createServer, type IncomingMessage } from 'node:http'

/** In-memory stand-in for the Actions cache service's twirp API plus its blob URLs. */
export async function fakeCacheService(): Promise<{
	url: string
	close(): void
}> {
	const entries = new Map<string, { blob?: Buffer; final: boolean }>()
	let port = 0
	const read = (req: IncomingMessage) =>
		new Promise<Buffer>((resolve) => {
			const chunks: Buffer[] = []
			req.on('data', (chunk: Buffer) => chunks.push(chunk))
			req.on('end', () => resolve(Buffer.concat(chunks)))
		})
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://x')
		const body = await read(req)
		const json = (status: number, payload: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(payload))
		}
		const blobUrl = (key: string) =>
			`http://127.0.0.1:${port}/blob/${encodeURIComponent(key)}`
		if (url.pathname.startsWith('/blob/')) {
			const key = decodeURIComponent(url.pathname.slice('/blob/'.length))
			if (req.method === 'PUT') {
				entries.set(key, { blob: body, final: false })
				res.writeHead(201).end()
			} else {
				const blob = entries.get(key)?.blob
				if (!blob) return void res.writeHead(404).end()
				res.writeHead(200).end(blob)
			}
			return
		}
		const method = url.pathname.split('/').pop()
		const request = JSON.parse(body.toString('utf8')) as {
			key: string
			restore_keys?: string[]
			size_bytes?: number
		}
		if (method === 'GetCacheEntryDownloadURL') {
			const final = [...entries].filter(([, e]) => e.final).map(([k]) => k)
			const match =
				final.find((k) => k === request.key) ??
				final
					.reverse()
					.find((k) => request.restore_keys?.some((p) => k.startsWith(p)))
			return match
				? json(200, {
						ok: true,
						signed_download_url: blobUrl(match),
						matched_key: match,
					})
				: json(200, { ok: false })
		}
		if (method === 'CreateCacheEntry') {
			return entries.get(request.key)?.final
				? json(200, { ok: false })
				: json(200, { ok: true, signed_upload_url: blobUrl(request.key) })
		}
		if (method === 'FinalizeCacheEntryUpload') {
			const entry = entries.get(request.key)
			if (!entry?.blob) return json(200, { ok: false })
			if (entry.blob.byteLength !== Number(request.size_bytes))
				return json(422, { msg: 'size mismatch' })
			entry.final = true
			return json(200, { ok: true })
		}
		json(404, { msg: `unknown ${method}` })
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	port = (server.address() as { port: number }).port
	return { url: `http://127.0.0.1:${port}/`, close: () => void server.close() }
}
