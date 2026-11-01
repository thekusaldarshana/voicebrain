import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline as pump } from 'node:stream/promises'
import { DriveNotConnected, type DriveTokenProvider } from './drive-tokens.ts'
import { checkFile, checkNote, checkUser, isAudioFile, payloadBytes, readAll, type NewNote, type NoteStorage, type Payload, type RetainAudio, type StoredStream } from './storage.ts'
import { NoteGone, UUID } from './util.ts'

/**
 * Notes in the user's own Google Drive, through the Drive v3 REST API (plain fetch, scope `drive.file`: the app
 * only ever sees files it created).
 *
 * Layout in each user's Drive:
 *   voicebrain/                  a folder the app created; found again by appProperties vbRole=root, never by name
 *     <noteId>/                  one folder per note (vbRole=note, vbNote=<noteId>)
 *       meta.json audio.* transcript.json digest.json edits.json     (every file carries vbNote=<noteId>)
 *
 * Every lookup goes by those appProperties markers, not by folder or name, so a duplicate folder (Drive allows
 * duplicate names) can never hide a note. A note EXISTS once its meta.json does, and meta.json is written last.
 *
 * Local files (under `cacheDir/<userId>/<noteId>/`):
 *   audio.*     a working copy of the recording; see `retainAudio`. Fetched back from Drive on demand.
 *   state.json  retry bookkeeping. Operational, so it never goes to Drive (it would cost an API call per note per pass).
 *
 * Assumes ONE server instance owns a user's folder. Locks are per process, which is what keeps look-up-then-create
 * from making duplicates; two instances racing on the same note could still make a duplicate (reads tolerate it).
 */

const FOLDER = 'application/vnd.google-apps.folder'
const FIELDS = 'id,name,mimeType,size,parents,appProperties,createdTime'
const RECENT_MS = 10 * 60_000 // Drive's search index lags; files this process wrote are trusted for this long
const MEMO_MS = 3_000 // a note's file list is reused briefly (a rebuild reads four files per note)
const CACHE_TTL_MS = 10 * 60_000
const SMALL = 5 * 1024 * 1024 // JSON at most this big goes in one multipart request
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded', 'backendError'])

interface DriveFile { id: string; name: string; mimeType?: string; size?: string; parents?: string[]; appProperties?: Record<string, string>; createdTime?: string }

/** Drive refused or failed. The message never carries file names, note text or tokens. */
export class DriveError extends Error {
  readonly status: number
  readonly reason: string
  readonly retryable: boolean
  constructor(message: string, status: number, reason = '', retryable = false) {
    super(message)
    this.status = status
    this.reason = reason
    this.retryable = retryable
  }
}

export interface DriveStorageOptions {
  /** Gives the access token for a user. Throws DriveNotConnected when that user has not connected Drive. */
  tokens: DriveTokenProvider
  /** Where audio working copies and state.json live on this machine. */
  cacheDir: string
  retainAudio?: RetainAudio
  apiBase?: string
  uploadBase?: string
  /** Name of the top-level folder the app creates. Never used to find it again. */
  rootName?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  /** `attempts` counts the first try; delays double from `baseMs` up to `maxMs`; a Retry-After wins, up to `maxRetryAfterMs`. */
  retry?: { attempts?: number; baseMs?: number; maxMs?: number; maxRetryAfterMs?: number }
  /** Resumable upload piece size. Drive wants a multiple of 256 KiB. */
  chunkBytes?: number
  /** Memory for recently read or written JSON files. */
  jsonCacheBytes?: number
}

interface UserState {
  rootId: string | null
  /** Files this process created or replaced lately, which Drive's search may not list yet. */
  recent: Map<string, { file: DriveFile; at: number }>
  /** Files this process deleted: Drive's search may keep listing them for a while. */
  tombstones: Set<string>
}

class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>()
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task, task)
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return result
  }
}

const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const marker = (key: string, value: string) => `appProperties has { key='${key}' and value='${quote(value)}' }`
const isFolder = (file: DriveFile) => file.mimeType === FOLDER
const mimeOf = (name: string) => (name.endsWith('.json') ? 'application/json' : 'application/octet-stream')
const copy = (bytes: Uint8Array) => bytes.slice()
const encode = (text: string) => new TextEncoder().encode(text)

const oldestFirst = (a: DriveFile, b: DriveFile) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || a.id.localeCompare(b.id)
const metaOf = (files: DriveFile[]) => files.filter(file => file.name === 'meta.json' && !isFolder(file)).sort(oldestFirst)[0]
const fileNamed = (files: DriveFile[], name: string) => files.filter(file => file.name === name && !isFolder(file)).sort(oldestFirst)[0]
const folderOf = (files: DriveFile[]) => files.filter(isFolder).sort(oldestFirst)[0]?.id ?? metaOf(files)?.parents?.[0]

function toIterable(data: Payload): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) return (async function* () { yield data })()
  return data as unknown as AsyncIterable<Uint8Array>
}

/** Cuts a stream into pieces of exactly `size` bytes (the last may be smaller), knowing which one is last. */
async function* chunked(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<{ data: Uint8Array; last: boolean }> {
  const iterator = source[Symbol.asyncIterator]()
  let queue: Uint8Array[] = []
  let queued = 0
  let done = false
  const take = (count: number) => {
    const out = new Uint8Array(count)
    let at = 0
    while (at < count) {
      const head = queue[0] as Uint8Array
      const part = Math.min(head.byteLength, count - at)
      out.set(head.subarray(0, part), at)
      at += part
      if (part === head.byteLength) queue.shift(); else queue[0] = head.subarray(part)
    }
    queued -= count
    return out
  }
  try {
    for (;;) {
      while (queued <= size && !done) {
        const next = await iterator.next()
        if (next.done) done = true; else { queue.push(next.value); queued += next.value.byteLength }
      }
      if (queued > size) yield { data: take(size), last: false }
      else { yield { data: take(queued), last: true }; return }
    }
  } finally { queue = []; await iterator.return?.() }
}

/** Passes the chunks through while writing them to a local file. */
async function* teeToFile(source: AsyncIterable<Uint8Array>, path: string): AsyncGenerator<Uint8Array> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w')
  try { for await (const chunk of source) { await handle.write(chunk); yield chunk } } finally { await handle.close() }
}

const contentRange = (from: number, to: number, total: string) => (to === from ? `bytes */${total}` : `bytes ${from}-${to - 1}/${total}`)
const committedBytes = (response: Response) => { const match = /bytes=0-(\d+)/.exec(response.headers.get('range') ?? ''); return match ? Number(match[1]) + 1 : 0 }
const discard = (response: Response) => response.body?.cancel().catch(() => undefined)

export class DriveStorage implements NoteStorage {
  readonly retainAudio: RetainAudio
  private readonly tokens: DriveTokenProvider
  private readonly cacheDir: string
  private readonly apiBase: string
  private readonly uploadBase: string
  private readonly rootName: string
  private readonly http: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly now: () => number
  private readonly retry: Required<NonNullable<DriveStorageOptions['retry']>>
  private readonly chunkBytes: number
  private readonly jsonCacheBytes: number
  private readonly locks = new KeyedLock()
  private readonly users = new Map<string, UserState>()
  private readonly memo = new Map<string, { at: number; files: DriveFile[] }>()
  private readonly inflight = new Map<string, Promise<DriveFile[]>>()
  /** Bumped whenever a note changes here, so a listing that started before the change is never remembered after it. */
  private readonly versions = new Map<string, number>()
  private readonly json = new Map<string, { bytes: Uint8Array; at: number }>()
  private jsonBytes = 0

  constructor(options: DriveStorageOptions) {
    this.retainAudio = options.retainAudio ?? 'keep'
    if (this.retainAudio !== 'keep' && this.retainAudio !== 'drop-after-digest') throw new Error('retainAudio must be "keep" or "drop-after-digest"')
    this.tokens = options.tokens
    this.cacheDir = options.cacheDir
    this.apiBase = (options.apiBase ?? 'https://www.googleapis.com/drive/v3').replace(/\/+$/, '')
    this.uploadBase = (options.uploadBase ?? 'https://www.googleapis.com/upload/drive/v3').replace(/\/+$/, '')
    this.rootName = options.rootName ?? 'voicebrain'
    this.http = options.fetch ?? fetch
    this.sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)))
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
    this.retry = { attempts: 6, baseMs: 500, maxMs: 30_000, maxRetryAfterMs: 120_000, ...options.retry }
    this.chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024
    if (this.chunkBytes % 262_144 !== 0) throw new Error('chunkBytes must be a multiple of 256 KiB')
    this.jsonCacheBytes = options.jsonCacheBytes ?? 32 * 1024 * 1024
  }

  // ---- the HTTP layer: tokens, retries, backoff ----

  private delay(attempt: number, retryAfterMs: number | null): number {
    const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempt - 1)) * (0.5 + this.random() * 0.5)
    return Math.max(backoff, Math.min(retryAfterMs ?? 0, this.retry.maxRetryAfterMs))
  }

  private retryAfter(response: Response): number | null {
    const value = response.headers.get('retry-after')
    if (!value) return null
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(value)
    return Number.isNaN(date) ? null : Math.max(0, date - this.now())
  }

  private async reason(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } }
      return String(body.error?.errors?.[0]?.reason ?? body.error?.status ?? '').slice(0, 60)
    } catch { return '' }
  }

  /**
   * One Drive call. Asks the provider for a token (DriveNotConnected passes through untouched); on a 401 asks
   * once more and retries, and a second 401 means access was revoked; 429, 5xx, network errors and 403 rate
   * limits are retried with exponential backoff and Retry-After. `accept` lists statuses the caller handles.
   */
  private async api(userId: string, what: string, send: (token: string) => Promise<Response>, options: { accept?: number[]; attempts?: number } = {}): Promise<Response> {
    const limit = options.attempts ?? this.retry.attempts
    let token = await this.tokens.accessToken(userId)
    let refreshed = false
    for (let attempt = 1; ; attempt += 1) {
      let response: Response | null = null
      try { response = await send(token) } catch { response = null }
      if (response) {
        if (response.ok || options.accept?.includes(response.status)) return response
        if (response.status === 401) {
          await discard(response)
          if (refreshed) throw new DriveNotConnected('Google Drive rejected a fresh access token: access was probably revoked.')
          refreshed = true
          token = await this.tokens.accessToken(userId)
          attempt -= 1
          continue
        }
        const reason = await this.reason(response)
        const retryable = response.status === 429 || response.status >= 500 || (response.status === 403 && RATE_REASONS.has(reason))
        const error = new DriveError(`Google Drive answered ${response.status}${reason ? ` (${reason})` : ''} for ${what}`, response.status, reason, retryable)
        if (!retryable || attempt >= limit) throw error
        await this.sleep(this.delay(attempt, this.retryAfter(response)))
        continue
      }
      const unreachable = new DriveError(`Google Drive could not be reached for ${what}`, 0, 'network', true)
      if (attempt >= limit) throw unreachable
      await this.sleep(this.delay(attempt, null))
    }
  }

  private request(url: string, token: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    return this.http(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(timeoutMs) })
  }

  private async listFiles(userId: string, query: string, fields = FIELDS, orderBy?: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '1000', fields: `nextPageToken,files(${fields})` })
      if (orderBy) params.set('orderBy', orderBy)
      if (pageToken) params.set('pageToken', pageToken)
      const response = await this.api(userId, 'files.list', token => this.request(`${this.apiBase}/files?${params}`, token))
      const body = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string }
      out.push(...(body.files ?? []))
      pageToken = body.nextPageToken
    } while (pageToken)
    return out
  }

  // ---- what this process knows beyond Drive's (laggy) search ----

  private state(userId: string): UserState {
    let state = this.users.get(userId)
    if (!state) { state = { rootId: null, recent: new Map(), tombstones: new Set() }; this.users.set(userId, state) }
    return state
  }

  private remember(userId: string, file: DriveFile) { this.state(userId).recent.set(file.id, { file, at: this.now() }) }

  private forget(userId: string, ids: string[]) {
    const state = this.state(userId)
    for (const id of ids) { state.recent.delete(id); state.tombstones.add(id) }
  }

  /** Forgets what is remembered about a note's file list: call after anything that changes the note. */
  private touch(key: string) {
    this.memo.delete(key)
    this.inflight.delete(key)
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
  }

  /**
   * Every file of a note that Drive (and this process) knows of: its folder and its files. Not gated on meta.json.
   * Readers share one listing; `fresh` always asks Drive (writes and deletes need the truth, not a 3 second old answer).
   */
  private snapshot(userId: string, noteId: string, fresh = false): Promise<DriveFile[]> {
    const key = `${userId}/${noteId}`
    if (!fresh) {
      const memo = this.memo.get(key)
      if (memo && this.now() - memo.at < MEMO_MS) return Promise.resolve(memo.files)
      const shared = this.inflight.get(key)
      if (shared) return shared
    }
    const version = this.versions.get(key) ?? 0
    const listing = this.listNote(userId, noteId).then(files => {
      if ((this.versions.get(key) ?? 0) === version) this.memo.set(key, { at: this.now(), files })
      return files
    })
    if (!fresh) {
      this.inflight.set(key, listing)
      const done = () => { if (this.inflight.get(key) === listing) this.inflight.delete(key) }
      listing.then(done, done)
    }
    return listing
  }

  private async listNote(userId: string, noteId: string): Promise<DriveFile[]> {
    const state = this.state(userId)
    const listed = await this.listFiles(userId, `${marker('vbNote', noteId)} and trashed = false`)
    const byId = new Map(listed.filter(file => !state.tombstones.has(file.id)).map(file => [file.id, file]))
    for (const [id, entry] of state.recent) {
      if (this.now() - entry.at > RECENT_MS) { state.recent.delete(id); continue }
      if (entry.file.appProperties?.vbNote === noteId) byId.set(id, entry.file)
    }
    return [...byId.values()]
  }

  private cacheJson(key: string, bytes: Uint8Array) {
    this.dropJson(key)
    if (bytes.byteLength > this.jsonCacheBytes / 4) return
    this.json.set(key, { bytes: copy(bytes), at: this.now() })
    this.jsonBytes += bytes.byteLength
    for (const [oldest, entry] of this.json) {
      if (this.jsonBytes <= this.jsonCacheBytes) break
      this.json.delete(oldest)
      this.jsonBytes -= entry.bytes.byteLength
    }
  }

  private dropJson(key: string) {
    const entry = this.json.get(key)
    if (entry) { this.json.delete(key); this.jsonBytes -= entry.bytes.byteLength }
  }

  private dropNoteCaches(userId: string, noteId: string) {
    this.touch(`${userId}/${noteId}`)
    for (const key of [...this.json.keys()]) if (key.startsWith(`${userId}/${noteId}/`)) this.dropJson(key)
  }

  private localDir(userId: string, noteId: string) { return join(this.cacheDir, checkUser(userId), checkNote(noteId)) }
  private localFile(userId: string, noteId: string, filename: string) { return join(this.localDir(userId, noteId), checkFile(filename)) }
  private goneOr(error: unknown, noteId: string): unknown { return error instanceof DriveError && error.status === 404 ? new NoteGone(noteId) : error }

  // ---- folders ----

  private async createFolder(userId: string, name: string, parent: string | null, appProperties: Record<string, string>): Promise<DriveFile> {
    const body = JSON.stringify({ name, mimeType: FOLDER, appProperties, ...(parent ? { parents: [parent] } : {}) })
    const response = await this.api(userId, 'files.create', token => this.request(`${this.apiBase}/files?fields=${FIELDS}`, token, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body }))
    const folder = (await response.json()) as DriveFile
    this.remember(userId, folder)
    return folder
  }

  /** The app's top-level folder: found by its marker, created once under a lock if the user has none. */
  private ensureRoot(userId: string): Promise<string> {
    return this.locks.run(`root:${userId}`, async () => {
      const state = this.state(userId)
      if (state.rootId) return state.rootId
      const found = (await this.listFiles(userId, `${marker('vbRole', 'root')} and mimeType = '${FOLDER}' and trashed = false`, FIELDS, 'createdTime'))
        .filter(file => !state.tombstones.has(file.id)).sort(oldestFirst)[0]
        ?? [...state.recent.values()].map(entry => entry.file).find(file => file.appProperties?.vbRole === 'root')
      const root = found ?? (await this.createFolder(userId, this.rootName, null, { vbRole: 'root' }))
      state.rootId = root.id
      return root.id
    })
  }

  // ---- uploads ----

  private async multipart(userId: string, url: string, method: string, metadata: object, bytes: Uint8Array, mime: string): Promise<DriveFile> {
    const boundary = `vb-${randomBytes(12).toString('hex')}`
    const head = encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`)
    const tail = encode(`\r\n--${boundary}--`)
    const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength)
    body.set(head, 0); body.set(bytes, head.byteLength); body.set(tail, head.byteLength + bytes.byteLength)
    const response = await this.api(userId, 'files.upload', token => this.request(url, token, { method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, 5 * 60_000))
    return (await response.json()) as DriveFile
  }

  /** Resumable upload, streamed in pieces: memory is one piece, not the file. A dropped piece is resumed from what Drive has. */
  private async resumable(userId: string, url: string, method: string, metadata: object, source: AsyncIterable<Uint8Array>, total: number | null, mime: string): Promise<DriveFile> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime }
    if (total !== null) headers['X-Upload-Content-Length'] = String(total)
    const init = await this.api(userId, 'files.upload (start)', token => this.request(url, token, { method, headers, body: JSON.stringify(metadata) }))
    const session = init.headers.get('location')
    await discard(init)
    if (!session) throw new DriveError('Google Drive did not start an upload session', 0, 'no-session')

    let committed = 0
    for await (const piece of chunked(source, this.chunkBytes)) {
      const start = committed
      const end = start + piece.data.byteLength
      const totalText = piece.last ? String(end) : '*'
      let failures = 0
      let stalls = 0
      for (;;) {
        const from = committed
        const slice = piece.data.subarray(from - start)
        try {
          const response = await this.api(userId, 'files.upload (piece)', token => this.request(session, token, { method: 'PUT', redirect: 'manual', headers: { 'Content-Range': contentRange(from, from + slice.byteLength, totalText) }, body: slice }, 10 * 60_000), { accept: [308], attempts: 1 })
          if (response.status !== 308) return (await response.json()) as DriveFile
          await discard(response)
          committed = committedBytes(response)
        } catch (error) {
          if (!(error instanceof DriveError) || !error.retryable) throw error
          failures += 1
          if (failures >= this.retry.attempts) throw error
          await this.sleep(this.delay(failures, null))
          const status = await this.api(userId, 'files.upload (status)', token => this.request(session, token, { method: 'PUT', redirect: 'manual', headers: { 'Content-Range': `bytes */${totalText}` } }), { accept: [308] })
          if (status.status !== 308) return (await status.json()) as DriveFile
          await discard(status)
          committed = committedBytes(status)
        }
        if (committed >= end) {
          if (piece.last) throw new DriveError('Google Drive did not finish the upload', 0, 'incomplete')
          break
        }
        stalls += 1
        if (stalls > this.retry.attempts * 4) throw new DriveError('Google Drive stopped accepting the upload', 0, 'stalled')
      }
    }
    throw new DriveError('The upload had no data', 0, 'empty')
  }

  private upload(userId: string, o: { note: string; name: string; parent: string; existingId?: string; data: Payload; role: 'file' | 'meta' }): Promise<DriveFile> {
    const appProperties = { vbRole: o.role, vbNote: o.note }
    const mime = mimeOf(o.name)
    const metadata = o.existingId ? { appProperties } : { name: o.name, parents: [o.parent], appProperties, mimeType: mime }
    const method = o.existingId ? 'PATCH' : 'POST'
    const target = o.existingId ? `${this.uploadBase}/files/${o.existingId}` : `${this.uploadBase}/files`
    const small = o.data instanceof Uint8Array && (o.data.byteLength === 0 || (o.data.byteLength <= SMALL && !isAudioFile(o.name)))
    if (small) return this.multipart(userId, `${target}?uploadType=multipart&fields=${FIELDS}`, method, metadata, o.data as Uint8Array, mime)
    return this.resumable(userId, `${target}?uploadType=resumable&fields=${FIELDS}`, method, metadata, toIterable(o.data), o.data instanceof Uint8Array ? o.data.byteLength : null, mime)
  }

  private async remove(userId: string, id: string): Promise<void> {
    const response = await this.api(userId, 'files.delete', token => this.request(`${this.apiBase}/files/${id}`, token, { method: 'DELETE' }), { accept: [404] })
    await discard(response)
  }

  private async download(userId: string, id: string): Promise<Response | null> {
    const response = await this.api(userId, 'files.get', token => this.request(`${this.apiBase}/files/${id}?alt=media`, token, {}, 10 * 60_000), { accept: [404] })
    if (response.status === 404) { await discard(response); return null }
    return response
  }

  /** Does this folder still exist? A direct lookup by id, which (unlike search) is immediately consistent. */
  private async alive(userId: string, folderId: string): Promise<boolean> {
    const response = await this.api(userId, 'files.get', token => this.request(`${this.apiBase}/files/${folderId}?fields=id,trashed`, token), { accept: [404] })
    if (response.status === 404) { await discard(response); return false }
    return (await response.json() as { trashed?: boolean }).trashed !== true
  }

  // ---- NoteStorage ----

  async hasNote(userId: string, noteId: string): Promise<boolean> {
    checkUser(userId); checkNote(noteId)
    return Boolean(metaOf(await this.snapshot(userId, noteId)))
  }

  async listNotes(userId: string): Promise<string[]> {
    checkUser(userId)
    const state = this.state(userId)
    const listed = await this.listFiles(userId, `${marker('vbRole', 'meta')} and trashed = false`, 'id,appProperties')
    const ids = new Set<string>()
    for (const file of listed) if (!state.tombstones.has(file.id) && file.appProperties?.vbNote) ids.add(file.appProperties.vbNote)
    for (const [id, entry] of state.recent) {
      if (this.now() - entry.at > RECENT_MS) { state.recent.delete(id); continue }
      if (entry.file.appProperties?.vbRole === 'meta' && entry.file.appProperties.vbNote) ids.add(entry.file.appProperties.vbNote)
    }
    return [...ids].filter(id => UUID.test(id)).sort()
  }

  async createNote(userId: string, noteId: string, note: NewNote): Promise<boolean> {
    checkUser(userId); checkNote(noteId)
    const files = Object.entries(note.files ?? {})
    for (const [name] of files) {
      checkFile(name)
      if (name === 'meta.json') throw new Error('meta.json is passed as `meta`, not in `files`')
    }
    return this.locks.run(`note:${userId}/${noteId}`, async () => {
      const existing = await this.snapshot(userId, noteId, true)
      if (metaOf(existing)) return false
      if (existing.length) await this.removeAll(userId, noteId, existing) // left by a crashed upload: not a note, and it must not linger

      let root = await this.ensureRoot(userId)
      let folder: DriveFile
      try { folder = await this.createFolder(userId, noteId, root, { vbRole: 'note', vbNote: noteId }) } catch (error) {
        if (!(error instanceof DriveError) || error.status !== 404) throw error
        // The user deleted the app's folder in Drive: forget it everywhere and make a new one.
        this.state(userId).rootId = null
        this.forget(userId, [root])
        root = await this.ensureRoot(userId)
        folder = await this.createFolder(userId, noteId, root, { vbRole: 'note', vbNote: noteId })
      }
      const staged: Array<{ tmp: string; final: string }> = []
      try {
        for (const [name, data] of files) {
          let body = data
          if (isAudioFile(name)) {
            const final = this.localFile(userId, noteId, name)
            const tmp = `${final}.${randomBytes(4).toString('hex')}.tmp`
            staged.push({ tmp, final })
            body = teeToFile(toIterable(data), tmp) as unknown as Payload
          } else body = await payloadBytes(data)
          const saved = await this.upload(userId, { note: noteId, name, parent: folder.id, data: body, role: 'file' })
          this.remember(userId, saved)
          if (!isAudioFile(name)) this.cacheJson(`${userId}/${noteId}/${name}`, body as Uint8Array)
        }
        const saved = await this.upload(userId, { note: noteId, name: 'meta.json', parent: folder.id, data: note.meta, role: 'meta' }) // last: the note exists only once complete
        this.remember(userId, saved)
        this.cacheJson(`${userId}/${noteId}/meta.json`, note.meta)
        for (const { tmp, final } of staged) await rename(tmp, final)
      } catch (error) {
        await this.removeAll(userId, noteId, [folder]).catch(() => undefined)
        this.dropNoteCaches(userId, noteId)
        await rm(this.localDir(userId, noteId), { recursive: true, force: true })
        throw this.goneOr(error, noteId)
      }
      this.touch(`${userId}/${noteId}`)
      return true
    })
  }

  async list(userId: string, noteId: string): Promise<string[]> {
    checkUser(userId); checkNote(noteId)
    const files = await this.snapshot(userId, noteId)
    if (!metaOf(files)) return []
    const names = new Set(files.filter(file => !isFolder(file)).map(file => file.name))
    if (await stat(this.localFile(userId, noteId, 'state.json')).then(() => true, () => false)) names.add('state.json')
    return [...names].sort()
  }

  async get(userId: string, noteId: string, filename: string): Promise<Uint8Array | null> {
    checkUser(userId); checkNote(noteId); checkFile(filename)
    if (filename === 'state.json') return readFile(this.localFile(userId, noteId, filename)).then(bytes => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), () => null)
    if (isAudioFile(filename)) {
      const found = await this.getStream(userId, noteId, filename)
      return found ? readAll(found.stream) : null
    }
    const key = `${userId}/${noteId}/${filename}`
    const cached = this.json.get(key)
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return copy(cached.bytes)
    const files = await this.snapshot(userId, noteId)
    const entry = metaOf(files) ? fileNamed(files, filename) : undefined
    if (!entry) return null
    const response = await this.download(userId, entry.id)
    if (!response) { this.touch(`${userId}/${noteId}`); return null }
    const bytes = new Uint8Array(await response.arrayBuffer())
    this.cacheJson(key, bytes)
    return bytes
  }

  async put(userId: string, noteId: string, filename: string, data: Payload): Promise<void> {
    checkUser(userId); checkNote(noteId); checkFile(filename)
    if (filename === 'state.json') return this.putState(userId, noteId, data)
    return this.locks.run(`file:${userId}/${noteId}/${filename}`, async () => {
      const files = await this.snapshot(userId, noteId, true)
      const folder = metaOf(files) ? folderOf(files) : undefined
      if (!folder) throw new NoteGone(noteId)
      const key = `${userId}/${noteId}/${filename}`
      let body = data
      let staged: { tmp: string; final: string } | null = null
      if (isAudioFile(filename)) {
        const final = this.localFile(userId, noteId, filename)
        staged = { tmp: `${final}.${randomBytes(4).toString('hex')}.tmp`, final }
        body = teeToFile(toIterable(data), staged.tmp) as unknown as Payload
      } else body = await payloadBytes(data)
      let saved: DriveFile
      try {
        saved = await this.upload(userId, { note: noteId, name: filename, parent: folder, existingId: fileNamed(files, filename)?.id, data: body, role: 'file' })
      } catch (error) {
        if (staged) await rm(staged.tmp, { force: true })
        throw this.goneOr(error, noteId)
      }
      // The note may have been deleted while this write was under way: then it must not leave a file behind.
      if (!(await this.alive(userId, folder))) {
        await this.remove(userId, saved.id).catch(() => undefined)
        this.forget(userId, [saved.id])
        if (staged) await rm(staged.tmp, { force: true })
        throw new NoteGone(noteId)
      }
      this.remember(userId, saved)
      this.touch(`${userId}/${noteId}`)
      if (staged) await rename(staged.tmp, staged.final)
      else this.cacheJson(key, body as Uint8Array)
    })
  }

  /** state.json is bookkeeping, not data worth an API call: it stays on this machine. */
  private async putState(userId: string, noteId: string, data: Payload): Promise<void> {
    if (!metaOf(await this.snapshot(userId, noteId, true))) throw new NoteGone(noteId)
    const bytes = await payloadBytes(data)
    const path = this.localFile(userId, noteId, 'state.json')
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, path)
    if (!metaOf(await this.snapshot(userId, noteId, true))) { // deleted meanwhile: leave no trace
      await rm(this.localDir(userId, noteId), { recursive: true, force: true })
      throw new NoteGone(noteId)
    }
  }

  async getStream(userId: string, noteId: string, filename: string): Promise<StoredStream | null> {
    checkUser(userId); checkNote(noteId); checkFile(filename)
    const local = this.localFile(userId, noteId, filename)
    const size = await stat(local).then(info => info.size, () => null)
    if (size !== null && isAudioFile(filename)) return { stream: Readable.toWeb(createReadStream(local)) as unknown as ReadableStream<Uint8Array>, size }
    const files = await this.snapshot(userId, noteId)
    const entry = metaOf(files) ? fileNamed(files, filename) : undefined
    if (!entry) return null
    const response = await this.download(userId, entry.id)
    if (!response?.body) { this.touch(`${userId}/${noteId}`); return null }
    if (!isAudioFile(filename)) return { stream: response.body as ReadableStream<Uint8Array>, size: entry.size === undefined ? null : Number(entry.size) }
    // Fetched back from Drive into a local file (never held in memory). Under `keep` it becomes the working copy;
    // under `drop-after-digest` it is deleted as soon as the reader is done with it.
    const tmp = `${local}.${randomBytes(4).toString('hex')}.tmp`
    await mkdir(dirname(local), { recursive: true })
    try { await pump(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp)) } catch (error) { await rm(tmp, { force: true }); throw error }
    const written = (await stat(tmp)).size
    if (entry.size !== undefined && Number(entry.size) !== written) { await rm(tmp, { force: true }); throw new DriveError('Google Drive sent a different amount of audio than it lists', 0, 'size-mismatch', true) }
    const keep = this.retainAudio === 'keep'
    const path = keep ? local : tmp
    if (keep) await rename(tmp, local)
    const reader = createReadStream(path)
    if (!keep) reader.once('close', () => { void rm(tmp, { force: true }) })
    return { stream: Readable.toWeb(reader) as unknown as ReadableStream<Uint8Array>, size: written }
  }

  private async removeAll(userId: string, noteId: string, files: DriveFile[]): Promise<void> {
    const folders = new Set(files.filter(isFolder).map(file => file.id))
    // Deleting a folder deletes what is in it; files outside any known folder are removed one by one.
    const targets = files.filter(file => isFolder(file) || !folders.has(file.parents?.[0] ?? ''))
    await Promise.all(targets.map(file => this.remove(userId, file.id)))
    this.forget(userId, files.map(file => file.id))
    this.dropNoteCaches(userId, noteId)
  }

  async deleteNote(userId: string, noteId: string): Promise<void> {
    checkUser(userId); checkNote(noteId)
    // Not under the note's write locks: a write in flight must lose to the delete, not hold it up.
    const files = await this.snapshot(userId, noteId, true)
    await this.removeAll(userId, noteId, files)
    await rm(this.localDir(userId, noteId), { recursive: true, force: true })
  }

  async releaseAudio(userId: string, noteId: string): Promise<void> {
    checkUser(userId); checkNote(noteId)
    if (this.retainAudio !== 'drop-after-digest') return
    const dir = this.localDir(userId, noteId)
    const names = await readdir(dir).catch(() => [] as string[])
    await Promise.all(names.filter(isAudioFile).map(name => rm(join(dir, name), { force: true })))
  }
}
