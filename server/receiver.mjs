#!/usr/bin/env node
/**
 * Reference receiver for Trapper Voice. Zero dependencies, Node 20+.
 *
 *   INGEST_TOKEN=secret node server/receiver.mjs            # listens on :8787, stores in server/data
 *   node server/receiver.mjs --insecure                     # no token (local testing only)
 *   node server/receiver.mjs pair --app https://voice.example.com --endpoint https://notes.example.com --token secret
 *
 * API
 *   GET  /health          -> 200 {"ok":true}                      (no auth, no details)
 *   GET  /v1/ping         -> 200 {"ok":true}                      (checks the token)
 *   POST /v1/notes        -> multipart: `meta` (JSON) + `audio` (file); header Idempotency-Key = note id
 *                            201 stored, 409 already stored. Both mean "done" to the app.
 *
 * Each note lands in <data>/inbox/<id>/{audio.<ext>, meta.json}. A later stage (transcription, wiki) can
 * watch the inbox. Nothing is deleted or rewritten here.
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const here = dirname(fileURLToPath(import.meta.url))
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024
const EXTENSIONS = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac' }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function pairingCommand(argv) {
  const get = name => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : '' }
  const app = get('app'); const endpoint = get('endpoint')
  if (!app || !endpoint) { console.error('Usage: receiver.mjs pair --app <app url> --endpoint <server url> [--token <token>] [--name <device name>]'); process.exit(2) }
  const params = new URLSearchParams({ e: endpoint })
  if (get('token')) params.set('t', get('token'))
  if (get('name')) params.set('n', get('name'))
  console.log(`${app.replace(/\/+$/, '')}/#/pair?${params}`)
}

export function createReceiver({ token = '', dataDir = join(here, 'data'), insecure = false } = {}) {
  const inbox = resolve(dataDir, 'inbox')
  const secret = Buffer.from(token)

  const authorized = request => {
    if (insecure) return true
    const header = request.headers.authorization ?? ''
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    return secret.length > 0 && given.length === secret.length && timingSafeEqual(given, secret)
  }

  const send = (response, status, body, extra = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra })
    response.end(JSON.stringify(body))
  }

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  }

  async function exists(path) { try { await stat(path); return true } catch { return false } }

  async function ingest(request, response) {
    const declared = Number(request.headers['content-length'] ?? 0)
    if (declared > MAX_BYTES) return send(response, 413, { error: 'too large' })
    let received = 0
    const body = Readable.toWeb(request).pipeThrough(new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > MAX_BYTES) controller.error(new Error('too large'))
        else controller.enqueue(chunk)
      },
    }))
    let form
    try {
      form = await new Request('http://receiver.local/', { method: 'POST', headers: { 'content-type': request.headers['content-type'] ?? '' }, body, duplex: 'half' }).formData()
    } catch (error) {
      return send(response, error?.message === 'too large' ? 413 : 400, { error: 'unreadable upload' })
    }
    let meta
    try { meta = JSON.parse(String(form.get('meta') ?? '')) } catch { return send(response, 422, { error: 'meta is not JSON' }) }
    const audio = form.get('audio')
    if (!meta || typeof meta.id !== 'string' || !ID.test(meta.id) || !audio || typeof audio === 'string') return send(response, 422, { error: 'meta.id and audio are required' })
    if (request.headers['idempotency-key'] && request.headers['idempotency-key'] !== meta.id) return send(response, 422, { error: 'Idempotency-Key must equal meta.id' })

    const directory = join(inbox, meta.id)
    if (await exists(join(directory, 'meta.json'))) return send(response, 409, { ok: true, id: meta.id, duplicate: true })

    const extension = EXTENSIONS[String(meta.mime ?? audio.type).split(';')[0].trim().toLowerCase()] ?? 'bin'
    const temporary = `${directory}.partial`
    await mkdir(temporary, { recursive: true })
    await writeFile(join(temporary, `audio.${extension}`), Buffer.from(await audio.arrayBuffer()))
    await writeFile(join(temporary, 'meta.json'), JSON.stringify({ ...meta, receivedAt: new Date().toISOString(), audioFile: `audio.${extension}`, audioBytes: audio.size }, null, 2))
    await rename(temporary, directory) // the note only "exists" once complete
    return send(response, 201, { ok: true, id: meta.id })
  }

  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url ?? '/', 'http://x')
      if (request.method === 'OPTIONS') { response.writeHead(204, cors); return response.end() }
      if (request.method === 'GET' && pathname === '/health') return send(response, 200, { ok: true })
      if (!authorized(request)) return send(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
      if (request.method === 'GET' && pathname === '/v1/ping') return send(response, 200, { ok: true })
      if (request.method === 'POST' && pathname === '/v1/notes') return await ingest(request, response)
      return send(response, 404, { error: 'not found' })
    } catch (error) {
      console.error(error)
      if (!response.headersSent) send(response, 500, { error: 'server error' })
    }
  })

  return {
    server,
    inbox,
    async notes() { return (await exists(inbox)) ? (await readdir(inbox)).filter(name => !name.endsWith('.partial')) : [] },
    listen: port => new Promise(done => server.listen(port, () => done(server.address().port))),
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done) }),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'pair') pairingCommand(process.argv.slice(3))
  else {
    const insecure = process.argv.includes('--insecure')
    const token = process.env.INGEST_TOKEN ?? ''
    if (!insecure && !token) { console.error('Set INGEST_TOKEN, or pass --insecure for local testing.'); process.exit(2) }
    const receiver = createReceiver({ token, insecure, dataDir: process.env.DATA_DIR ?? join(here, 'data') })
    const port = await receiver.listen(Number(process.env.PORT ?? 8787))
    console.log(`Trapper Voice receiver on :${port}, inbox ${receiver.inbox}${insecure ? ' (NO AUTH)' : ''}`)
  }
}
