import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { DriveTokenProvider } from '../src/drive-tokens.ts'

/**
 * An in-process Google Drive v3, just the subset DriveStorage uses:
 *   files.list (q with appProperties / name / mimeType / parents / trashed, orderBy, paging), files.get (metadata and
 *   alt=media), files.create (metadata), files.delete (permanent, recursive for folders), multipart upload,
 *   resumable upload (session, pieces, status query), and PATCH uploads that replace content atomically.
 *
 * Accounts come from the bearer token: `tok-<account>-<anything>`. Faults: `expire(token)`, `revoke(account)`,
 * `inject(...)` for any status or a dropped connection, `searchLagMs` for Drive's laggy search, `pageSize` to force paging.
 * No real Google call is ever made.
 */

const FOLDER = 'application/vnd.google-apps.folder'

interface Rec { id: string; account: string; name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; content: Buffer | null; createdAt: number; deletedAt?: number }
interface Session { account: string; metadata: { name?: string; parents?: string[]; appProperties?: Record<string, string>; mimeType?: string }; targetId: string | null; received: Buffer[]; length: number }
export interface Seen { method: string; path: string; query: Record<string, string>; status: number; account: string | null }
export type Inject = { status: number; headers?: Record<string, string>; body?: unknown } | 'drop' | 'drop-after'

const CHUNK_UNIT = 256 * 1024

export class FakeDrive {
  url = ''
  /** Search results hide files younger than this, and keep listing deleted ones this long. */
  searchLagMs = 0
  /** Largest page files.list returns (forces nextPageToken). */
  pageSize = 1000
  readonly requests: Seen[] = []
  /** Bytes in every resumable piece received, in order. */
  readonly pieceSizes: number[] = []
  private readonly records = new Map<string, Rec>()
  private readonly sessions = new Map<string, Session>()
  private readonly expired = new Set<string>()
  private readonly revoked = new Set<string>()
  private injector: ((request: { method: string; path: string; query: Record<string, string>; account: string; index: number }) => Inject | undefined) | null = null
  private server: Server | null = null

  get apiBase() { return `${this.url}/drive/v3` }
  get uploadBase() { return `${this.url}/upload/drive/v3` }

  async start(): Promise<this> {
    this.server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>(done => this.server!.listen(0, '127.0.0.1', done))
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
    return this
  }

  close(): Promise<void> {
    return new Promise<void>(done => { this.server?.closeAllConnections?.(); this.server?.close(() => done()) })
  }

  /** Tokens that do not follow the `tok-<account>-…` naming (a real sign-in flow mints its own): token → account. */
  readonly tokenAccounts = new Map<string, string>()
  expire(token: string) { this.expired.add(token) }
  revoke(account: string) { this.revoked.add(account) }
  inject(fn: FakeDrive['injector']) { this.injector = fn }

  /** What is really in an account's Drive, with search and lag out of the picture. */
  files(account: string): Array<{ id: string; name: string; parents: string[]; folder: boolean; size: number; appProperties: Record<string, string> }> {
    return [...this.records.values()].filter(rec => rec.account === account && !rec.deletedAt).map(rec => ({ id: rec.id, name: rec.name, parents: rec.parents, folder: rec.mimeType === FOLDER, size: rec.content?.byteLength ?? 0, appProperties: rec.appProperties }))
  }
  content(account: string, name: string, parentName?: string): Buffer | undefined {
    const parent = parentName ? [...this.records.values()].find(rec => rec.account === account && rec.name === parentName && rec.mimeType === FOLDER) : undefined
    return [...this.records.values()].find(rec => rec.account === account && rec.name === name && (!parent || rec.parents.includes(parent.id)))?.content ?? undefined
  }
  /** Deletes a file or folder behind the app's back (the user tidying their Drive). */
  purge(account: string, name: string) {
    const root = [...this.records.values()].find(rec => rec.account === account && rec.name === name && !rec.deletedAt)
    if (root) this.delete(account, root.id, () => undefined, () => undefined)
  }
  count(match: (seen: Seen) => boolean) { return this.requests.filter(match).length }
  openSessions() { return this.sessions.size }

  // ---- HTTP ----

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake')
    const query = Object.fromEntries(url.searchParams.entries())
    const method = request.method ?? 'GET'
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const seen: Seen = { method, path: url.pathname, query, status: 0, account: null }
    this.requests.push(seen)
    let loseResponse = false
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      seen.status = status
      if (loseResponse) { response.socket?.destroy(); return }
      const text = payload === undefined ? '' : JSON.stringify(payload)
      response.writeHead(status, { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers })
      response.end(text)
    }
    const fail = (status: number, reason: string) => send(status, { error: { code: status, message: reason, errors: [{ reason }], status: reason } })

    const token = /^Bearer (.+)$/.exec(String(request.headers.authorization ?? ''))?.[1] ?? ''
    const account = this.tokenAccounts.get(token) ?? /^tok-([A-Za-z0-9]+)-/.exec(token)?.[1] ?? ''
    const isSession = url.pathname.startsWith('/upload/session/')
    if (!isSession && (!account || this.expired.has(token) || this.revoked.has(account))) return fail(401, 'authError')
    if (isSession && account && (this.expired.has(token) || this.revoked.has(account))) return fail(401, 'authError')
    seen.account = account || null

    const injected = this.injector?.({ method, path: url.pathname, query, account, index: this.requests.length - 1 })
    if (injected === 'drop') { response.socket?.destroy(); return }
    if (injected === 'drop-after') loseResponse = true // handled for real below, but the answer never arrives
    if (injected && injected !== 'drop-after') { seen.status = injected.status; response.writeHead(injected.status, { 'Content-Type': 'application/json', ...injected.headers }); response.end(JSON.stringify(injected.body ?? { error: { code: injected.status, errors: [{ reason: 'injected' }] } })); return }

    try {
      const driveFile = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
      const uploadFile = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname)
      if (url.pathname === '/drive/v3/files' && method === 'GET') return this.list(account, query, send, fail)
      if (url.pathname === '/drive/v3/files' && method === 'POST') return this.createMetadata(account, body, send, fail)
      if (driveFile && method === 'GET') return this.get(account, driveFile[1] as string, query, response, seen, send, fail)
      if (driveFile && method === 'DELETE') return this.delete(account, driveFile[1] as string, send, fail)
      if (uploadFile && (method === 'POST' || method === 'PATCH')) return this.upload(account, uploadFile[1] ?? null, query, request, body, send, fail)
      if (isSession && method === 'PUT') return this.piece(url.pathname.slice('/upload/session/'.length), request, body, send, fail)
      fail(404, 'notFound')
    } catch (error) {
      fail(500, `fake: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private mine(account: string, id: string): Rec | undefined {
    const rec = this.records.get(id)
    return rec && rec.account === account && !rec.deletedAt ? rec : undefined
  }

  private resource(rec: Rec) {
    return { id: rec.id, name: rec.name, mimeType: rec.mimeType, parents: rec.parents, appProperties: rec.appProperties, createdTime: new Date(rec.createdAt).toISOString(), ...(rec.content ? { size: String(rec.content.byteLength) } : {}) }
  }

  private list(account: string, query: Record<string, string>, send: (s: number, p?: unknown, h?: Record<string, string>) => void, fail: (s: number, r: string) => void) {
    let rest = query.q ?? ''
    const props: Array<[string, string]> = []
    rest = rest.replace(/appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/g, (_, key: string, value: string) => { props.push([key.replace(/\\(.)/g, '$1'), value.replace(/\\(.)/g, '$1')]); return '' })
    let name: string | null = null
    rest = rest.replace(/name = '((?:[^'\\]|\\.)*)'/, (_, value: string) => { name = value.replace(/\\(.)/g, '$1'); return '' })
    let mime: string | null = null
    rest = rest.replace(/mimeType = '([^']*)'/, (_, value: string) => { mime = value; return '' })
    let parent: string | null = null
    rest = rest.replace(/'([^']*)' in parents/, (_, value: string) => { parent = value; return '' })
    rest = rest.replace(/trashed = false/, '').replace(/\band\b/g, '').trim()
    if (rest) return fail(400, `invalidQuery: unsupported "${rest}"`)
    const now = Date.now()
    const visible = [...this.records.values()].filter(rec => {
      if (rec.account !== account) return false
      if (rec.deletedAt ? now - rec.deletedAt >= this.searchLagMs : now - rec.createdAt < this.searchLagMs) return false // deleted long ago, or not indexed yet
      if (name !== null && rec.name !== name) return false
      if (mime !== null && rec.mimeType !== mime) return false
      if (parent !== null && !rec.parents.includes(parent)) return false
      return props.every(([key, value]) => rec.appProperties[key] === value)
    })
    visible.sort(query.orderBy === 'createdTime' ? (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id) : (a, b) => a.id.localeCompare(b.id))
    const size = Math.min(Number(query.pageSize ?? 100), this.pageSize)
    const from = Number(query.pageToken ?? 0)
    const page = visible.slice(from, from + size)
    send(200, { files: page.map(rec => this.resource(rec)), ...(from + size < visible.length ? { nextPageToken: String(from + size) } : {}) })
  }

  private createMetadata(account: string, body: Buffer, send: (s: number, p?: unknown) => void, fail: (s: number, r: string) => void) {
    const metadata = JSON.parse(body.toString('utf8')) as Session['metadata']
    for (const parent of metadata.parents ?? []) if (!this.mine(account, parent)) return fail(404, 'notFound')
    const rec = this.add(account, metadata, metadata.mimeType === FOLDER ? null : Buffer.alloc(0))
    send(200, this.resource(rec))
  }

  private add(account: string, metadata: Session['metadata'], content: Buffer | null): Rec {
    const rec: Rec = { id: randomUUID().replace(/-/g, ''), account, name: metadata.name ?? 'Untitled', mimeType: metadata.mimeType ?? 'application/octet-stream', parents: metadata.parents ?? [], appProperties: metadata.appProperties ?? {}, content, createdAt: Date.now() }
    this.records.set(rec.id, rec)
    return rec
  }

  private get(account: string, id: string, query: Record<string, string>, response: ServerResponse, seen: Seen, send: (s: number, p?: unknown) => void, fail: (s: number, r: string) => void) {
    const rec = this.mine(account, id)
    if (!rec) return fail(404, 'notFound')
    if (query.alt !== 'media') return send(200, { ...this.resource(rec), trashed: false })
    if (!rec.content) return fail(403, 'fileNotDownloadable')
    seen.status = 200
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(rec.content.byteLength) })
    response.end(rec.content)
  }

  private delete(account: string, id: string, send: (s: number, p?: unknown) => void, fail: (s: number, r: string) => void) {
    const rec = this.mine(account, id)
    if (!rec) return fail(404, 'notFound')
    const doomed = [rec]
    for (let index = 0; index < doomed.length; index += 1) for (const child of this.records.values()) if (child.account === account && !child.deletedAt && child.parents.includes((doomed[index] as Rec).id)) doomed.push(child)
    const now = Date.now()
    for (const item of doomed) { item.deletedAt = now; item.content = item.content && Buffer.from(item.content) } // permanent: it only lingers in (laggy) search
    if (this.searchLagMs === 0) for (const item of doomed) this.records.delete(item.id)
    send(204)
  }

  private upload(account: string, targetId: string | null, query: Record<string, string>, request: IncomingMessage, body: Buffer, send: (s: number, p?: unknown, h?: Record<string, string>) => void, fail: (s: number, r: string) => void) {
    const target = targetId ? this.mine(account, targetId) : undefined
    if (targetId && !target) return fail(404, 'notFound')
    if (query.uploadType === 'resumable') {
      const metadata = JSON.parse(body.toString('utf8') || '{}') as Session['metadata']
      for (const parent of metadata.parents ?? []) if (!this.mine(account, parent)) return fail(404, 'notFound')
      const id = randomUUID()
      this.sessions.set(id, { account, metadata, targetId, received: [], length: 0 })
      return send(200, undefined, { Location: `${this.url}/upload/session/${id}` })
    }
    if (query.uploadType !== 'multipart') return fail(400, 'badUploadType')
    const boundary = /boundary=(.+)$/.exec(String(request.headers['content-type'] ?? ''))?.[1]
    if (!boundary) return fail(400, 'badContentType')
    const parts = splitMultipart(body, boundary)
    if (parts.length !== 2) return fail(400, 'badMultipart')
    const metadata = JSON.parse((parts[0] as Buffer).toString('utf8')) as Session['metadata']
    for (const parent of metadata.parents ?? []) if (!this.mine(account, parent)) return fail(404, 'notFound')
    send(200, this.resource(this.commit(account, target ?? null, metadata, parts[1] as Buffer)))
  }

  private commit(account: string, target: Rec | null, metadata: Session['metadata'], content: Buffer): Rec {
    if (target) {
      target.content = content // one assignment: a reader sees the old bytes or the new ones
      if (metadata.appProperties) target.appProperties = { ...target.appProperties, ...metadata.appProperties }
      return target
    }
    return this.add(account, metadata, content)
  }

  private piece(id: string, request: IncomingMessage, body: Buffer, send: (s: number, p?: unknown, h?: Record<string, string>) => void, fail: (s: number, r: string) => void) {
    const session = this.sessions.get(id)
    if (!session) return fail(404, 'notFound')
    const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(String(request.headers['content-range'] ?? ''))
    if (!range) return fail(400, 'badContentRange')
    const total = range[3] === '*' ? null : Number(range[3])
    const incomplete = () => send(308, undefined, session.length ? { Range: `bytes=0-${session.length - 1}` } : {})
    const finish = () => {
      for (const parent of session.metadata.parents ?? []) if (!this.mine(session.account, parent)) { this.sessions.delete(id); return fail(404, 'notFound') }
      const target = session.targetId ? this.mine(session.account, session.targetId) : undefined
      if (session.targetId && !target) { this.sessions.delete(id); return fail(404, 'notFound') }
      this.sessions.delete(id)
      send(200, this.resource(this.commit(session.account, target ?? null, session.metadata, Buffer.concat(session.received))))
    }
    if (range[1] === undefined) { // a status query, or finishing an upload whose bytes are all there
      if (total !== null && session.length === total) return finish()
      return incomplete()
    }
    const first = Number(range[1])
    const last = Number(range[2])
    if (body.byteLength !== last - first + 1) return fail(400, 'badContentLength')
    this.pieceSizes.push(body.byteLength)
    if (first !== session.length) return incomplete() // out of step: tell the client where we are
    if (total === null && body.byteLength % CHUNK_UNIT !== 0) return fail(400, 'chunkNotMultipleOf256KiB')
    session.received.push(body)
    session.length += body.byteLength
    if (total !== null && session.length === total) return finish()
    incomplete()
  }
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delimiter = Buffer.from(`--${boundary}`)
  const out: Buffer[] = []
  let at = body.indexOf(delimiter)
  while (at >= 0) {
    const start = at + delimiter.length
    if (body.subarray(start, start + 2).toString() === '--') break
    const next = body.indexOf(delimiter, start)
    if (next < 0) break
    const part = body.subarray(start + 2, next - 2) // drop the CRLF after the boundary and before the next
    const split = part.indexOf('\r\n\r\n')
    out.push(part.subarray(split + 4))
    at = next
  }
  return out
}

/** Tokens named after the user, so the fake knows whose Drive a request is for. `issue` can hand out a different one per call. */
export class FakeTokens implements DriveTokenProvider {
  readonly calls: string[] = []
  private readonly issue: (userId: string, call: number) => string | Promise<string>
  constructor(issue: (userId: string, call: number) => string | Promise<string> = userId => `tok-${userId}-1`) { this.issue = issue }
  async accessToken(userId: string): Promise<string> {
    this.calls.push(userId)
    return this.issue(userId, this.calls.filter(call => call === userId).length)
  }
}
