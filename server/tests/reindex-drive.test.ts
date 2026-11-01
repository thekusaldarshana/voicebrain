import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Brain } from '../src/brain.ts'
import type { Config } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { DriveStorage } from '../src/storage-drive.ts'
import { OWNER_ID, readAll, type RetainAudio } from '../src/storage.ts'
import type { NoteMeta } from '../src/types.ts'
import { FakeDrive, FakeTokens } from './fake-drive.ts'
import { CREATED_AT, NOTE_ID, fakeLlm, fakeStt, tempDir, testConfig, waitFor, type Fake } from './helpers.ts'

const AUDIO = Uint8Array.from({ length: 4096 }, (_, index) => index % 251)
const SECOND = '44444444-4444-4444-8444-444444444444'
const THIRD = '66666666-6666-4666-8666-666666666666'
const IDS = [NOTE_ID, SECOND, THIRD]

let stt: Fake
let llm: Fake
let drive: FakeDrive
const cleanups: Array<() => Promise<void>> = []

const meta = (id: string, createdAt: string): NoteMeta => ({ id, createdAt, durationMs: 10_500, mime: 'audio/webm', size: 8, title: '', tags: [], marks: [8000], recovered: false, source: 'record', device: 'Pixel', timezone: 'Asia/Colombo', utcOffsetMinutes: 330, app: 'test', receivedAt: createdAt, audioFile: null, audioBytes: 0 })
const providers = (dir: string, extra: Partial<Config> = {}) => testConfig(dir, { stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'whisper-test', language: 'en', maxMb: 24, prompt: '' }, llm: { baseUrl: llm.url, apiKey: '', model: 'llm-test', maxInputChars: 20_000 }, ...extra })

/** A server on a machine of its own (its own disk), whose notes are in the shared Drive. */
async function machine(retainAudio: RetainAudio = 'keep', options: { init?: boolean } = {}) {
  const dir = await tempDir()
  const storage = new DriveStorage({ tokens: new FakeTokens(), cacheDir: join(dir.dir, 'cache'), apiBase: drive.apiBase, uploadBase: drive.uploadBase, retainAudio })
  const brain = new Brain(providers(dir.dir), undefined, storage)
  if (options.init === false) await brain.vault.init() // what `node src/main.ts reindex` does: no startup rebuild first
  else await brain.init()
  const pipeline = new Pipeline(brain, { retryDelay: () => 30, log: () => undefined })
  cleanups.push(async () => { await pipeline.stop(); brain.close(); await dir.clean() })
  return { brain, pipeline, storage, dir: dir.dir }
}

async function pages(brain: Brain) {
  const out: Record<string, string | null> = {}
  for (const root of ['notes', 'daily', 'projects', 'people']) for (const path of await brain.vault.listMarkdown(root)) out[path] = await brain.vault.read(path)
  out['tasks.md'] = await brain.vault.read('tasks.md')
  return out
}

beforeEach(async () => { stt = await fakeStt(); llm = await fakeLlm(); drive = await new FakeDrive().start() })
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); await stt.close(); await llm.close(); await drive.close() })

describe('everything derived can be rebuilt from Drive', () => {
  it('rebuilds the same vault pages and search on a machine with an empty disk', async () => {
    const first = await machine()
    for (const [id, at] of [[NOTE_ID, CREATED_AT], [SECOND, '2026-10-30T05:00:00.000Z'], [THIRD, '2026-10-29T08:15:00.000Z']] as const) await first.brain.store.saveUpload(meta(id, at), AUDIO, 'webm')
    first.pipeline.kick()
    for (const id of IDS) await waitFor(() => first.brain.index.note(id)?.digested === 1, `note ${id.slice(0, 8)} to be digested`)
    await first.pipeline.idle()
    await first.brain.editNote(SECOND, { title: 'Bank errands' }, 'user')
    const wanted = await pages(first.brain)
    const hits = first.brain.search('trapper')
    expect(Object.keys(wanted).length).toBeGreaterThan(6)

    const second = await machine('keep', { init: false }) // nothing local: not the index, not the vault, not an audio copy
    const before = drive.requests.length
    expect(await second.brain.reindex()).toMatchObject({ notes: 3 })
    const calls = drive.requests.slice(before)

    expect(await pages(second.brain)).toEqual(wanted)
    expect(second.brain.search('trapper')).toEqual(hits)
    expect(await second.brain.getNote(NOTE_ID)).not.toBeNull()
    // The cost of a rebuild, so a change that makes it worse is noticed: one list for the ids; then per note one list of
    // its files (shared by the four reads) and a download of each of meta, transcript, digest and edits (edits exist for one).
    expect(calls.filter(seen => seen.query.alt === 'media')).toHaveLength(3 * 3 + 1)
    expect(calls).toHaveLength(1 + 3 + 10)
    expect(calls.some(seen => seen.method !== 'GET')).toBe(false) // a rebuild only reads
    expect(await readdir(join(second.dir, 'cache')).catch(() => [])).toEqual([]) // and no audio was pulled down for it
  })

  it('keeps working while Drive pushes back: 429s during a rebuild only slow it down', async () => {
    const first = await machine()
    await first.brain.store.saveUpload(meta(NOTE_ID, CREATED_AT), AUDIO, 'webm')
    first.pipeline.kick()
    await waitFor(() => first.brain.index.note(NOTE_ID)?.digested === 1, 'the note to be digested')
    await first.pipeline.idle()
    const second = await machine('keep', { init: false })
    let refusals = 0
    drive.inject(request => (request.method === 'GET' && refusals++ % 3 === 0 ? { status: 429, headers: { 'Retry-After': '0' } } : undefined))
    expect(await second.brain.reindex()).toMatchObject({ notes: 1 })
    expect(await second.brain.getNote(NOTE_ID)).not.toBeNull()
    expect(refusals).toBeGreaterThan(3) // several of the rebuild's reads were refused and retried
  })
})

describe('the pipeline on Drive', () => {
  it('drop-after-digest: the audio is only in Drive once the note is done, and can be played back', async () => {
    const { brain, pipeline, dir } = await machine('drop-after-digest')
    await brain.store.saveUpload(meta(NOTE_ID, CREATED_AT), AUDIO, 'webm')
    expect(await readdir(join(dir, 'cache', OWNER_ID, NOTE_ID))).toEqual(['audio.webm']) // the working copy, for transcribing
    pipeline.kick()
    await waitFor(() => brain.index.note(NOTE_ID)?.digested === 1, 'the note to be digested')
    await pipeline.idle()
    expect(stt.requests[0]?.fields.file).toBe(`file:${AUDIO.byteLength}`) // transcribed from the working copy
    expect(await readdir(join(dir, 'cache', OWNER_ID, NOTE_ID))).toEqual([]) // evicted
    const found = await brain.store.audio((await brain.store.meta(NOTE_ID))!) // playback fetches it back from Drive
    expect(Buffer.compare(await readAll(found!.stream), AUDIO)).toBe(0)
  })

  it('a delete that lands mid-transcription leaves nothing in Drive, on disk, or in the index', async () => {
    stt.respond(() => ({ body: { text: 'hello', segments: [] }, delayMs: 400 }))
    const { brain, pipeline, dir } = await machine()
    await brain.store.saveUpload(meta(NOTE_ID, CREATED_AT), AUDIO, 'webm')
    pipeline.kick()
    await waitFor(() => stt.requests.length === 1, 'the transcription to start')
    expect(await brain.deleteNote(NOTE_ID)).not.toBeNull()
    await new Promise(done => setTimeout(done, 700))
    await pipeline.idle()
    expect(drive.files(OWNER_ID).filter(file => file.appProperties.vbNote === NOTE_ID || file.name === NOTE_ID)).toEqual([])
    expect(brain.index.note(NOTE_ID)).toBeUndefined()
    expect(await readdir(join(dir, 'cache', OWNER_ID)).catch(() => [])).toEqual([])
    expect(await pipeline.status()).toMatchObject({ notes: 0, failed: [] })
    expect(llm.requests).toHaveLength(0)
  })

  it('an idle pass over finished notes costs a single Drive call', async () => {
    const { brain, pipeline } = await machine()
    for (const [id, at] of [[NOTE_ID, CREATED_AT], [SECOND, '2026-10-30T05:00:00.000Z']] as const) await brain.store.saveUpload(meta(id, at), AUDIO, 'webm')
    pipeline.kick()
    for (const id of [NOTE_ID, SECOND]) await waitFor(() => brain.index.note(id)?.digested === 1, 'digests')
    await pipeline.idle()
    const before = drive.requests.length
    pipeline.kick()
    await pipeline.idle()
    expect(drive.requests.length - before).toBe(1) // the listing of ids; everything else is remembered
  })
})
