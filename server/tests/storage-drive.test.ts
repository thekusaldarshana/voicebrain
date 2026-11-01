import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DriveNotConnected } from '../src/drive-tokens.ts'
import { DriveError, DriveStorage, type DriveStorageOptions } from '../src/storage-drive.ts'
import { OWNER_ID, readAll } from '../src/storage.ts'
import { NoteGone } from '../src/util.ts'
import { FakeDrive, FakeTokens } from './fake-drive.ts'
import { tempDir } from './helpers.ts'

const A = '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b'
const B = '44444444-4444-4444-8444-444444444444'
const ACCOUNT = OWNER_ID
const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes))
const meta = (id: string) => encode(JSON.stringify({ id }))
const pattern = (size: number) => Uint8Array.from({ length: size }, (_, index) => (index * 7 + (index >> 8)) % 251)
const streamOf = (chunks: Uint8Array[], options: { gate?: Promise<void>; failAfter?: number } = {}) => {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.gate && sent === 1) await options.gate
      if (options.failAfter !== undefined && sent >= options.failAfter) { controller.error(new Error('the microphone fell out')); return }
      const next = chunks[sent]
      if (next) { controller.enqueue(next); sent += 1 } else controller.close()
    },
  })
}
const pieces = (bytes: Uint8Array, size: number) => Array.from({ length: Math.ceil(bytes.byteLength / size) }, (_, index) => bytes.slice(index * size, (index + 1) * size))
const same = (a: Uint8Array | null, b: Uint8Array) => a !== null && Buffer.compare(a, b) === 0
const gate = () => { let open!: () => void; const promise = new Promise<void>(done => { open = done }); return { promise, open } }

const open: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of open.splice(0).reverse()) await close() })

interface Rig { fake: FakeDrive; storage: DriveStorage; tokens: FakeTokens; sleeps: number[]; dir: string; make: (extra?: Partial<DriveStorageOptions>) => DriveStorage }

async function rig(extra: Partial<DriveStorageOptions> = {}, tokens = new FakeTokens()): Promise<Rig> {
  const fake = await new FakeDrive().start()
  const dir = await tempDir()
  open.push(async () => { await fake.close(); await dir.clean() })
  const sleeps: number[] = []
  const make = (more: Partial<DriveStorageOptions> = {}) => new DriveStorage({ tokens, cacheDir: dir.dir, apiBase: fake.apiBase, uploadBase: fake.uploadBase, chunkBytes: 262_144, random: () => 1, sleep: async ms => { sleeps.push(ms) }, retry: { baseMs: 100, maxMs: 10_000 }, ...extra, ...more })
  return { fake, storage: make(), tokens, sleeps, dir: dir.dir, make }
}

describe('the layout in Drive', () => {
  it('keeps one app folder and one folder per note, found by markers, with meta.json written last', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': pattern(300_000), 'transcript.json': encode('{}') } })
    const all = fake.files(ACCOUNT)
    const root = all.find(file => file.name === 'voicebrain')
    const folder = all.find(file => file.name === A)
    expect(root?.appProperties).toEqual({ vbRole: 'root' })
    expect(folder).toMatchObject({ folder: true, parents: [root?.id], appProperties: { vbRole: 'note', vbNote: A } })
    expect(all.filter(file => file.parents.includes(folder!.id)).map(file => file.name).sort()).toEqual(['audio.webm', 'meta.json', 'transcript.json'])
    // creation order: the folder, then the files, meta.json last
    const uploads = fake.requests.filter(seen => seen.path.startsWith('/upload/') && seen.method === 'POST' && seen.query.uploadType === 'multipart').length
    expect(uploads).toBe(2) // transcript.json and meta.json; the audio goes the resumable way
    expect(fake.requests.filter(seen => seen.query.uploadType === 'resumable')).toHaveLength(1)
  })

  it('never looks anything up by name alone, and only asks for files marked as its own', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A) })
    await storage.get(OWNER_ID, B, 'meta.json')
    await storage.listNotes(OWNER_ID)
    for (const seen of fake.requests.filter(request => request.path === '/drive/v3/files' && request.method === 'GET')) {
      expect(seen.query.q, seen.query.q).toMatch(/appProperties has \{ key='vb(Note|Role)' and value='[^']+' \}/)
      expect(seen.query.spaces).toBe('drive')
    }
  })

  it('finds its folder again after a restart instead of making a second one', async () => {
    const { fake, make } = await rig()
    await make().createNote(OWNER_ID, A, { meta: meta(A) })
    const restarted = make()
    await restarted.createNote(OWNER_ID, B, { meta: meta(B) })
    expect(fake.files(ACCOUNT).filter(file => file.name === 'voicebrain')).toHaveLength(1)
    expect(await restarted.listNotes(OWNER_ID)).toEqual([A, B].sort())
  })

  it('makes a new app folder when the user deleted it in Drive', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A) })
    fake.purge(ACCOUNT, 'voicebrain') // takes its notes with it
    expect(await storage.createNote(OWNER_ID, B, { meta: meta(B) })).toBe(true)
    expect(fake.files(ACCOUNT).filter(file => file.name === 'voicebrain')).toHaveLength(1)
    expect(decode(await storage.get(OWNER_ID, B, 'meta.json'))).toBe(JSON.stringify({ id: B }))
  })

  it('reads on when Drive holds more than one app folder (a duplicate from an earlier race)', async () => {
    const { fake, make } = await rig()
    const first = make()
    await first.createNote(OWNER_ID, A, { meta: meta(A) })
    await fetch(`${fake.apiBase}/files`, { method: 'POST', headers: { Authorization: 'Bearer tok-owner-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'voicebrain', mimeType: 'application/vnd.google-apps.folder', appProperties: { vbRole: 'root' } }) })
    const second = make()
    expect(await second.createNote(OWNER_ID, B, { meta: meta(B) })).toBe(true)
    expect(await second.listNotes(OWNER_ID)).toEqual([A, B].sort())
  })

  it('pages through more notes than one answer holds', async () => {
    const { fake, storage } = await rig()
    fake.pageSize = 2
    const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    for (const id of ids) await storage.createNote(OWNER_ID, id, { meta: meta(id) })
    const fresh = new DriveStorage({ tokens: new FakeTokens(), cacheDir: (await tempDir()).dir, apiBase: fake.apiBase, uploadBase: fake.uploadBase })
    expect(await fresh.listNotes(OWNER_ID)).toEqual(ids)
  })
})

describe('concurrent creation does not duplicate folders or files', () => {
  it('makes one app folder for many notes created at once, and one note folder per note', async () => {
    const { fake, storage } = await rig()
    const ids = Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
    await Promise.all(ids.map(id => storage.createNote(OWNER_ID, id, { meta: meta(id), files: { 'audio.webm': encode(id) } })))
    const all = fake.files(ACCOUNT)
    expect(all.filter(file => file.name === 'voicebrain')).toHaveLength(1)
    for (const id of ids) {
      expect(all.filter(file => file.name === id), id).toHaveLength(1)
      expect(all.filter(file => file.name === 'meta.json' && file.appProperties.vbNote === id), id).toHaveLength(1)
    }
  })

  it('makes one note folder when the same note is created at once', async () => {
    const { fake, storage } = await rig()
    const results = await Promise.all(Array.from({ length: 6 }, () => storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': encode('x') } })))
    expect(results.filter(Boolean)).toHaveLength(1)
    const all = fake.files(ACCOUNT)
    expect(all.filter(file => file.name === A)).toHaveLength(1)
    expect(all.filter(file => file.name === 'audio.webm')).toHaveLength(1)
  })
})

describe('Drive search lags behind writes', () => {
  it('still sees what this process wrote, and what it deleted stays deleted', async () => {
    const { fake, storage } = await rig()
    fake.searchLagMs = 60_000 // search shows nothing new, and keeps showing what was deleted
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'transcript.json': encode('words') } })
    expect(await storage.hasNote(OWNER_ID, A)).toBe(true)
    expect(await storage.listNotes(OWNER_ID)).toEqual([A])
    await storage.put(OWNER_ID, A, 'digest.json', encode('digest'))
    expect(await storage.list(OWNER_ID, A)).toEqual(['digest.json', 'meta.json', 'transcript.json'])
    await storage.put(OWNER_ID, A, 'digest.json', encode('digest 2')) // replaces the file it just made, not a second one
    expect(fake.files(ACCOUNT).filter(file => file.name === 'digest.json')).toHaveLength(1)
    await storage.deleteNote(OWNER_ID, A)
    expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
    expect(await storage.listNotes(OWNER_ID)).toEqual([])
    expect(await storage.get(OWNER_ID, A, 'meta.json')).toBeNull()
    expect(fake.files(ACCOUNT).filter(file => file.appProperties.vbNote === A)).toEqual([])
    await expect(storage.put(OWNER_ID, A, 'digest.json', encode('late'))).rejects.toBeInstanceOf(NoteGone)
  })
})

describe('tokens and access', () => {
  it('asks the provider for a fresh token once after a 401, then carries on', async () => {
    const tokens = new FakeTokens((user, call) => `tok-${user}-${call === 1 ? 'old' : 'new'}`)
    const { fake, storage } = await rig({}, tokens)
    fake.expire('tok-owner-old')
    expect(await storage.createNote(OWNER_ID, A, { meta: meta(A) })).toBe(true)
    expect(fake.requests.filter(seen => seen.status === 401)).toHaveLength(1)
    expect(tokens.calls.length).toBeGreaterThanOrEqual(2)
    expect(fake.requests.at(-1)?.status).toBeLessThan(300)
  })

  it('reports DriveNotConnected when Drive keeps refusing a fresh token (access revoked)', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A) })
    fake.revoke(ACCOUNT)
    const attempts = [
      () => storage.listNotes(OWNER_ID), () => storage.hasNote(OWNER_ID, B), () => storage.createNote(OWNER_ID, B, { meta: meta(B) }),
      () => storage.put(OWNER_ID, A, 'digest.json', encode('x')), () => storage.deleteNote(OWNER_ID, A), () => storage.getStream(OWNER_ID, A, 'audio.webm'),
    ]
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(DriveNotConnected)
  })

  it('lets DriveNotConnected from the provider through untouched, without calling Drive', async () => {
    const refusal = new DriveNotConnected('This user has not connected Google Drive.')
    const { fake, storage } = await rig({}, new FakeTokens(() => { throw refusal }))
    for (const call of [() => storage.listNotes(OWNER_ID), () => storage.hasNote(OWNER_ID, A), () => storage.createNote(OWNER_ID, A, { meta: meta(A) }), () => storage.get(OWNER_ID, A, 'meta.json'), () => storage.deleteNote(OWNER_ID, A)]) {
      await expect(call()).rejects.toBe(refusal)
    }
    expect(fake.requests).toEqual([])
  })

  it('uses each user\'s own token, and never lets one user reach another\'s Drive', async () => {
    const { fake, storage } = await rig()
    await storage.createNote('alice', A, { meta: encode('alice') })
    await storage.createNote('bob', A, { meta: encode('bob') })
    expect(new Set(fake.requests.map(seen => seen.account))).toEqual(new Set(['alice', 'bob']))
    expect(fake.files('alice').find(file => file.name === 'voicebrain')).toBeDefined()
    expect(fake.files('bob').find(file => file.name === 'voicebrain')).toBeDefined()
    expect(fake.files('alice').find(file => file.name === 'voicebrain')?.id).not.toBe(fake.files('bob').find(file => file.name === 'voicebrain')?.id)
    expect(await storage.listNotes('carol')).toEqual([])
  })
})

describe('retries and backoff', () => {
  const failing = (fake: FakeDrive, status: number, times: number, headers: Record<string, string> = {}, reason = 'rateLimitExceeded') => {
    let used = 0
    fake.inject(request => (request.method === 'GET' && request.path === '/drive/v3/files' && used++ < times ? { status, headers, body: { error: { code: status, errors: [{ reason }] } } } : undefined))
  }

  it('backs off exponentially on 5xx and succeeds when Drive recovers', async () => {
    const { fake, storage, sleeps } = await rig()
    failing(fake, 503, 3)
    expect(await storage.listNotes(OWNER_ID)).toEqual([])
    expect(sleeps).toEqual([100, 200, 400]) // random() = 1: no jitter taken off
  })

  it('honors Retry-After on 429, in seconds or as a date', async () => {
    const { fake, storage, sleeps } = await rig({ now: () => Date.parse('2026-11-02T10:00:00Z') })
    failing(fake, 429, 1, { 'Retry-After': '7' })
    await storage.listNotes(OWNER_ID)
    expect(sleeps).toEqual([7000])
    failing(fake, 429, 1, { 'Retry-After': 'Mon, 02 Nov 2026 10:00:09 GMT' })
    await storage.listNotes(OWNER_ID)
    expect(sleeps.at(-1)).toBe(9000)
  })

  it('caps an absurd Retry-After', async () => {
    const { fake, storage, sleeps } = await rig()
    failing(fake, 429, 1, { 'Retry-After': '86400' })
    await storage.listNotes(OWNER_ID)
    expect(sleeps).toEqual([120_000])
  })

  it('retries a 403 that means "slow down", but not one that means "no"', async () => {
    const { fake, storage, sleeps } = await rig()
    failing(fake, 403, 2, {}, 'userRateLimitExceeded')
    await storage.listNotes(OWNER_ID)
    expect(sleeps).toHaveLength(2)
    sleeps.length = 0
    failing(fake, 403, 99, {}, 'storageQuotaExceeded')
    const before = fake.requests.length
    const error = await storage.listNotes(OWNER_ID).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DriveError)
    expect(error).toMatchObject({ status: 403, reason: 'storageQuotaExceeded', retryable: false })
    expect(fake.requests.length - before).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('gives up after a bounded number of tries and says so without leaking anything', async () => {
    const tokens = new FakeTokens(user => `tok-${user}-secretsecret`)
    const { fake, storage, sleeps } = await rig({ retry: { attempts: 4, baseMs: 100, maxMs: 250 } }, tokens)
    failing(fake, 500, 99)
    const error = (await storage.listNotes(OWNER_ID).catch((caught: unknown) => caught)) as DriveError
    expect(error).toBeInstanceOf(DriveError)
    expect(error.status).toBe(500)
    expect(sleeps).toEqual([100, 200, 250]) // doubling, capped
    expect(fake.requests).toHaveLength(4)
    expect(error.message).not.toContain('secretsecret')
  })

  it('retries when the connection drops', async () => {
    const { fake, storage, sleeps } = await rig()
    let dropped = 0
    fake.inject(request => (request.path === '/drive/v3/files' && dropped++ < 2 ? 'drop' : undefined))
    expect(await storage.listNotes(OWNER_ID)).toEqual([])
    expect(sleeps).toHaveLength(2)
  })

  it('keeps note text, file names and tokens out of error messages', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A) })
    fake.inject(request => (request.method === 'POST' && request.path.startsWith('/upload/') ? { status: 400, body: { error: { code: 400, message: 'bad: my private transcript words', errors: [{ reason: 'invalid' }] } } } : undefined))
    const error = (await storage.put(OWNER_ID, A, 'transcript.json', encode('my private transcript words')).catch((caught: unknown) => caught)) as Error
    expect(error).toBeInstanceOf(DriveError)
    expect(error.message).not.toMatch(/private|transcript|tok-/)
  })
})

describe('uploads', () => {
  it('streams audio in pieces no bigger than one chunk, without buffering the file', async () => {
    const { fake, storage } = await rig()
    const audio = pattern(1_300_000)
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': streamOf(pieces(audio, 5_000)) } })
    expect(fake.pieceSizes.slice(0, -1).every(size => size === 262_144)).toBe(true)
    expect(Math.max(...fake.pieceSizes)).toBe(262_144)
    expect(fake.pieceSizes.reduce((sum, size) => sum + size, 0)).toBe(audio.byteLength)
    expect(Buffer.compare(fake.content(ACCOUNT, 'audio.webm')!, audio)).toBe(0)
  })

  it('handles a recording that is an exact multiple of the chunk size, and an empty one', async () => {
    const { fake, storage } = await rig()
    const exact = pattern(262_144 * 2)
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': streamOf(pieces(exact, 100_000)) } })
    expect(Buffer.compare(fake.content(ACCOUNT, 'audio.webm', A)!, exact)).toBe(0)
    await storage.createNote(OWNER_ID, B, { meta: meta(B), files: { 'audio.webm': new Uint8Array(0) } })
    expect(await storage.get(OWNER_ID, B, 'audio.webm')).toEqual(new Uint8Array(0))
  })

  it('resumes a piece the connection dropped, from what Drive actually has', async () => {
    const { fake, storage, sleeps } = await rig()
    const audio = pattern(900_000)
    let puts = 0
    fake.inject(request => (request.method === 'PUT' && request.path.startsWith('/upload/session/') && ++puts === 2 ? 'drop' : undefined))
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': audio } })
    expect(sleeps).toHaveLength(1)
    expect(Buffer.compare(fake.content(ACCOUNT, 'audio.webm', A)!, audio)).toBe(0)
  })

  it('does not send a piece twice when Drive took it but the answer was lost', async () => {
    const { fake, storage } = await rig()
    const audio = pattern(900_000)
    let puts = 0
    fake.inject(request => (request.method === 'PUT' && request.path.startsWith('/upload/session/') && ++puts === 1 ? 'drop-after' : undefined))
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': audio } })
    expect(Buffer.compare(fake.content(ACCOUNT, 'audio.webm', A)!, audio)).toBe(0)
    expect(fake.pieceSizes.reduce((sum, size) => sum + size, 0)).toBe(audio.byteLength) // no byte arrived twice
  })

  it('shows nothing of a half-uploaded note until it is complete', async () => {
    const { fake, storage } = await rig()
    const hold = gate()
    const outcome = storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': streamOf([pattern(300_000), pattern(300_000), pattern(10)], { gate: hold.promise }) } })
    await new Promise(done => setTimeout(done, 50))
    // mid-upload: the folder and part of the audio are in Drive, but the note does not exist for anyone
    expect(fake.files(ACCOUNT).some(file => file.name === A)).toBe(true)
    expect(fake.files(ACCOUNT).some(file => file.name === 'meta.json')).toBe(false)
    expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
    expect(await storage.listNotes(OWNER_ID)).toEqual([])
    expect(await storage.list(OWNER_ID, A)).toEqual([])
    expect(await storage.get(OWNER_ID, A, 'meta.json')).toBeNull()
    hold.open()
    expect(await outcome).toBe(true)
    expect(await storage.hasNote(OWNER_ID, A)).toBe(true)
    expect(await storage.list(OWNER_ID, A)).toEqual(['audio.webm', 'meta.json'])
  })

  it('removes the partial note, and the local copy, when the source fails midway', async () => {
    const { fake, storage, dir } = await rig()
    const error = await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': streamOf([pattern(400_000), pattern(400_000)], { failAfter: 1 }) } }).catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('the microphone fell out')
    expect(fake.files(ACCOUNT).filter(file => file.appProperties.vbNote === A)).toEqual([])
    expect(await storage.listNotes(OWNER_ID)).toEqual([])
    expect(await readdir(join(dir, OWNER_ID))).toEqual([])
  })

  it('replaces audio and any file atomically, as a new revision of the same Drive file', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': pattern(300_000) } })
    const before = fake.files(ACCOUNT).find(file => file.name === 'audio.webm')?.id
    await storage.put(OWNER_ID, A, 'audio.webm', streamOf(pieces(pattern(600_000), 77_777)))
    const after = fake.files(ACCOUNT).filter(file => file.name === 'audio.webm')
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(before)
    expect(after[0]?.size).toBe(600_000)
  })
})

describe('deleting', () => {
  it('deletes permanently, never to the trash, and leaves nothing in Drive or on disk', async () => {
    const { fake, storage, dir } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': pattern(300_000), 'transcript.json': encode('private words') } })
    await storage.put(OWNER_ID, A, 'state.json', encode('{}'))
    await storage.deleteNote(OWNER_ID, A)
    expect(fake.files(ACCOUNT).filter(file => file.appProperties.vbNote === A || file.name === A)).toEqual([])
    expect(fake.requests.some(seen => seen.method === 'DELETE')).toBe(true)
    expect(fake.requests.some(seen => seen.method === 'PATCH' && seen.path === '/drive/v3/files/' + seen.path.split('/').pop())).toBe(false) // nothing was merely "trashed"
    expect(await readdir(join(dir, OWNER_ID)).catch(() => [])).toEqual([]) // not even an empty folder for the note
  })

  it('wins against an audio upload still under way: NoteGone, and no file, session or cache is left', async () => {
    const { fake, storage, dir } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': pattern(1000) } })
    const hold = gate()
    const writing = storage.put(OWNER_ID, A, 'audio.webm', streamOf([pattern(300_000), pattern(300_000), pattern(5)], { gate: hold.promise }))
    const outcome = writing.then(() => 'written', (error: unknown) => error)
    await new Promise(done => setTimeout(done, 50))
    await storage.deleteNote(OWNER_ID, A)
    hold.open()
    expect(await outcome).toBeInstanceOf(NoteGone)
    expect(fake.files(ACCOUNT).filter(file => file.appProperties.vbNote === A || file.name === A)).toEqual([])
    expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
    expect(await readdir(join(dir, OWNER_ID, A)).catch(() => [])).toEqual([])
  })

  it('wins against a JSON write that is still arriving', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A) })
    const hold = gate()
    const outcome = storage.put(OWNER_ID, A, 'transcript.json', streamOf([encode('one'), encode('two')], { gate: hold.promise })).then(() => 'written', (error: unknown) => error)
    await new Promise(done => setTimeout(done, 30))
    await storage.deleteNote(OWNER_ID, A)
    hold.open()
    expect(await outcome).toBeInstanceOf(NoteGone)
    expect(fake.files(ACCOUNT).filter(file => file.appProperties.vbNote === A)).toEqual([])
  })

  it('cleans up a file a write made after its folder was deleted', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A) })
    // The folder disappears after the upload has been accepted but before the write checks on it.
    let deleted = false
    fake.inject(request => {
      if (!deleted && request.method === 'GET' && request.path.startsWith('/drive/v3/files/') && request.query.fields === 'id,trashed') {
        deleted = true
        fake.purge(ACCOUNT, A)
      }
      return undefined
    })
    await expect(storage.put(OWNER_ID, A, 'digest.json', encode('late'))).rejects.toBeInstanceOf(NoteGone)
    expect(fake.files(ACCOUNT).filter(file => file.appProperties.vbNote === A || file.name === A)).toEqual([])
  })

  it('removes an upload a crash left half done, the next time the note is created', async () => {
    const { fake, make } = await rig()
    const hold = gate()
    const crashed = make()
    void crashed.createNote(OWNER_ID, A, { meta: meta(A), files: { 'transcript.json': encode('kept in the folder'), 'audio.webm': streamOf([pattern(300_000), pattern(10)], { gate: hold.promise }) } }).catch(() => undefined)
    await new Promise(done => setTimeout(done, 80))
    expect(fake.files(ACCOUNT).some(file => file.name === 'transcript.json')).toBe(true) // the half-made note is in Drive, without meta.json
    const restarted = make()
    expect(await restarted.hasNote(OWNER_ID, A)).toBe(false)
    expect(await restarted.createNote(OWNER_ID, A, { meta: meta(A) })).toBe(true)
    expect(await restarted.list(OWNER_ID, A)).toEqual(['meta.json']) // the stale transcript did not come along
    hold.open()
  })
})

describe('audio on this machine (retainAudio)', () => {
  it('keep: a copy fetched back from Drive becomes the working copy and is read from disk afterwards', async () => {
    const { fake, make, dir } = await rig()
    const audio = pattern(500_000)
    await make().createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': audio } })
    await readdir(join(dir, OWNER_ID, A)).then(names => expect(names).toEqual(['audio.webm']))
    const restarted = make({ cacheDir: (await tempDir()).dir }) // a machine with an empty disk
    const reads = () => fake.count(seen => seen.query.alt === 'media')
    expect(same(await readAll((await restarted.getStream(OWNER_ID, A, 'audio.webm'))!.stream), audio)).toBe(true)
    expect(reads()).toBe(1)
    expect(same(await restarted.get(OWNER_ID, A, 'audio.webm'), audio)).toBe(true)
    expect(reads()).toBe(1) // from the local copy
  })

  it('drop-after-digest: released audio is fetched back into a temp file that is deleted after use', async () => {
    const { fake, storage, dir } = await rig({ retainAudio: 'drop-after-digest' })
    const audio = pattern(500_000)
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': audio } })
    const local = join(dir, OWNER_ID, A)
    expect(await readdir(local)).toEqual(['audio.webm']) // the working copy, until the pipeline is done
    await storage.releaseAudio(OWNER_ID, A)
    expect(await readdir(local)).toEqual([])
    const found = await storage.getStream(OWNER_ID, A, 'audio.webm')
    expect(found?.size).toBe(audio.byteLength)
    expect((await readdir(local)).length).toBe(1) // the temp file exists while the reader has it
    expect(same(await readAll(found!.stream), audio)).toBe(true)
    await new Promise(done => setTimeout(done, 50))
    expect(await readdir(local)).toEqual([]) // and is gone once it has been read
    expect(fake.count(seen => seen.query.alt === 'media')).toBe(1)
    expect(same(await storage.get(OWNER_ID, A, 'audio.webm'), audio)).toBe(true) // again, from Drive
    expect(fake.count(seen => seen.query.alt === 'media')).toBe(2)
  })

  it('drop-after-digest: a reader that gives up early does not leave the temp file behind', async () => {
    const { storage, dir } = await rig({ retainAudio: 'drop-after-digest' })
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': pattern(500_000) } })
    await storage.releaseAudio(OWNER_ID, A)
    const found = await storage.getStream(OWNER_ID, A, 'audio.webm')
    await found!.stream.cancel()
    await new Promise(done => setTimeout(done, 80))
    expect(await readdir(join(dir, OWNER_ID, A))).toEqual([])
  })
})

describe('what is kept off Drive, and what is cached', () => {
  it('keeps state.json on this machine: no upload, still listed and readable, gone with the note', async () => {
    const { fake, storage } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A) })
    await storage.put(OWNER_ID, A, 'state.json', encode('{"attempts":1}'))
    expect(fake.files(ACCOUNT).some(file => file.name === 'state.json')).toBe(false)
    expect(decode(await storage.get(OWNER_ID, A, 'state.json'))).toBe('{"attempts":1}')
    expect(await storage.list(OWNER_ID, A)).toEqual(['meta.json', 'state.json'])
    const before = fake.requests.length
    await storage.get(OWNER_ID, A, 'state.json')
    expect(fake.requests.length).toBe(before) // the pipeline reads it every few seconds; that must not cost a call
    await storage.deleteNote(OWNER_ID, A)
    expect(await storage.get(OWNER_ID, A, 'state.json')).toBeNull()
    await expect(storage.put(OWNER_ID, A, 'state.json', encode('{}'))).rejects.toBeInstanceOf(NoteGone)
    expect(await storage.get(OWNER_ID, A, 'state.json')).toBeNull() // and the refused write left no file
  })

  it('serves repeat reads of a note\'s JSON from memory, and rereads after a write', async () => {
    const { fake, storage, make } = await rig()
    await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'transcript.json': encode('v1') } })
    const cold = make() // nothing cached
    const reads = () => fake.count(seen => seen.query.alt === 'media')
    expect(decode(await cold.get(OWNER_ID, A, 'transcript.json'))).toBe('v1')
    const first = reads()
    for (let index = 0; index < 5; index += 1) await cold.get(OWNER_ID, A, 'transcript.json')
    expect(reads()).toBe(first)
    await cold.put(OWNER_ID, A, 'transcript.json', encode('v2'))
    expect(decode(await cold.get(OWNER_ID, A, 'transcript.json'))).toBe('v2')
    expect(decode(await make().get(OWNER_ID, A, 'transcript.json'))).toBe('v2') // and Drive has it
  })

  it('asks Drive one question to list notes, however many there are', async () => {
    const { fake, storage } = await rig()
    for (const id of [A, B]) await storage.createNote(OWNER_ID, id, { meta: meta(id) })
    const before = fake.requests.length
    await storage.listNotes(OWNER_ID)
    expect(fake.requests.length - before).toBe(1)
  })
})
