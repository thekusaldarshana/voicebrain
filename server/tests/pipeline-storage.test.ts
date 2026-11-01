import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Brain } from '../src/brain.ts'
import type { Config } from '../src/config.ts'
import { Pipeline } from '../src/pipeline.ts'
import { OWNER_ID, readAll, type RetainAudio } from '../src/storage.ts'
import type { NoteMeta } from '../src/types.ts'
import { CREATED_AT, NOTE_ID, TRANSCRIPT, fakeLlm, fakeStt, tempDir, testConfig, waitFor, type Fake } from './helpers.ts'
import { MemoryStorage } from './memory-storage.ts'

const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
const SECOND = '44444444-4444-4444-8444-444444444444'

let dir: Awaited<ReturnType<typeof tempDir>>
let stt: Fake
let llm: Fake
const open: Array<() => Promise<void>> = []

const meta = (id: string, createdAt = CREATED_AT): NoteMeta => ({ id, createdAt, durationMs: 10_500, mime: 'audio/webm', size: 8, title: '', tags: [], marks: [8000], recovered: false, source: 'record', device: 'Pixel', timezone: 'Asia/Colombo', utcOffsetMinutes: 330, app: 'test', receivedAt: createdAt, audioFile: null, audioBytes: 0 })
const providers = (extra: Partial<Config> = {}, where = dir.dir) => testConfig(where, { stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'whisper-test', language: 'en', maxMb: 24, prompt: '' }, llm: { baseUrl: llm.url, apiKey: '', model: 'llm-test', maxInputChars: 20_000 }, ...extra })

/** A server's worth of brain and pipeline whose notes live in `storage`, not on this machine's disk. */
async function boot(storage: MemoryStorage, config: Config = providers()) {
  const brain = new Brain(config, undefined, storage)
  await brain.init()
  const pipeline = new Pipeline(brain, { retryDelay: () => 30, log: () => undefined })
  open.push(async () => { await pipeline.stop(); brain.close() })
  return { brain, pipeline, storage }
}
const settled = async (brain: Brain, id: string) => waitFor(() => brain.index.note(id)?.digested === 1, `note ${id.slice(0, 8)} to be digested`)

beforeEach(async () => { dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm() })
afterEach(async () => { for (const close of open.splice(0)) await close(); await stt.close(); await llm.close(); await dir.clean() })

describe('the pipeline on a backend that is not the local disk', () => {
  it('transcribes, digests, files and searches a note without writing an inbox', async () => {
    const { brain, pipeline, storage } = await boot(new MemoryStorage())
    await brain.store.saveUpload(meta(NOTE_ID), AUDIO, 'webm')
    pipeline.kick()
    await settled(brain, NOTE_ID)
    expect(await storage.list(OWNER_ID, NOTE_ID)).toEqual(['audio.webm', 'digest.json', 'meta.json', 'transcript.json'])
    expect(brain.search('bank')[0]?.ref).toBe(NOTE_ID)
    expect(stt.requests[0]?.fields.file).toBe(`file:${AUDIO.byteLength}`) // the audio came from storage, byte for byte
    expect(existsSync(join(dir.dir, 'inbox'))).toBe(false)
    expect(existsSync(join(dir.dir, 'vault', 'notes', '2026', '10', '2026-10-30-0912-3f2b1c0e.md'))).toBe(true) // derived data stays local
  })

  it('deleting through the interface leaves no trace, even when the delete lands mid-transcription', async () => {
    stt.respond(() => ({ body: { text: TRANSCRIPT, segments: [] }, delayMs: 400 }))
    const { brain, pipeline, storage } = await boot(new MemoryStorage())
    await brain.store.saveUpload(meta(NOTE_ID), AUDIO, 'webm')
    pipeline.kick()
    await waitFor(() => stt.requests.length === 1, 'the transcription to start')
    expect(await brain.deleteNote(NOTE_ID)).toMatchObject({ title: expect.any(String) })
    await new Promise(done => setTimeout(done, 700)) // the transcription answers after the delete
    await pipeline.idle()
    expect(storage.allKeys()).toEqual([]) // nothing anywhere: not the files, not a cache entry
    expect(brain.index.note(NOTE_ID)).toBeUndefined()
    expect(await pipeline.status()).toMatchObject({ notes: 0, failed: [] }) // and it is not reported as a failure
    expect(llm.requests).toHaveLength(0)
    expect(await brain.deleteNote(NOTE_ID)).toBeNull() // already gone
  })

  it('a machine with an empty disk and the same storage rebuilds the same notes, pages and search', async () => {
    const storage = new MemoryStorage()
    const first = await boot(storage)
    await first.brain.store.saveUpload(meta(NOTE_ID), AUDIO, 'webm')
    await first.brain.store.saveUpload(meta(SECOND, '2026-10-30T05:00:00.000Z'), AUDIO, 'webm')
    first.pipeline.kick()
    await settled(first.brain, NOTE_ID)
    await settled(first.brain, SECOND)
    await first.brain.editNote(SECOND, { title: 'Bank errands' }, 'user')
    const pages = async (brain: Brain) => Object.fromEntries(await Promise.all([...(await brain.vault.listMarkdown('notes')), ...(await brain.vault.listMarkdown('daily')), ...(await brain.vault.listMarkdown('projects')), ...(await brain.vault.listMarkdown('people'))].map(async path => [path, await brain.vault.read(path)])))
    const wanted = await pages(first.brain)
    const hits = first.brain.search('trapper')

    const elsewhere = await tempDir() // a new machine: no index, no vault, nothing on disk
    try {
      const second = await boot(storage, providers({}, elsewhere.dir))
      await second.brain.reindex()
      expect(await pages(second.brain)).toEqual(wanted)
      expect(second.brain.search('trapper')).toEqual(hits)
      expect(second.brain.index.noteCount()).toBe(2)
    } finally { await elsewhere.clean() }
  })

  // Not a goal of this change, and worth saying out loud: these two live in the vault (git), not in storage.
  it('known gap: task statuses and wiki pages are not in storage, so a machine with an empty disk loses them', async () => {
    const storage = new MemoryStorage()
    const first = await boot(storage)
    await first.brain.store.saveUpload(meta(NOTE_ID), AUDIO, 'webm')
    first.pipeline.kick()
    await settled(first.brain, NOTE_ID)
    await first.brain.updateTask(`${NOTE_ID}#0`, 'done')
    await first.brain.wikiWrite('projects/trapper.md', '# Trapper\nmine', 'replace')
    const elsewhere = await tempDir()
    try {
      const second = await boot(storage, providers({}, elsewhere.dir))
      await second.brain.reindex()
      expect(second.brain.openLoops().map(task => task.text)).toContain('Call the bank') // done in the first, open again here
      expect(second.brain.wikiList()).not.toContain('wiki/projects/trapper.md') // only the seeded index page is there
    } finally { await elsewhere.clean() }
  })
})

describe('retainAudio', () => {
  const run = async (retainAudio: RetainAudio, extra: Partial<Config> = {}) => {
    const booted = await boot(new MemoryStorage({ retainAudio }), providers(extra))
    await booted.brain.store.saveUpload(meta(NOTE_ID), AUDIO, 'webm')
    booted.pipeline.kick()
    return booted
  }

  it('keep: the audio stays where it was put', async () => {
    const { brain, storage } = await run('keep')
    await settled(brain, NOTE_ID)
    await brain.store.audioBytes((await brain.store.meta(NOTE_ID))!)
    expect(storage.isCached(OWNER_ID, NOTE_ID, 'audio.webm')).toBe(true)
    expect(storage.remoteFetches).toBe(0)
  })

  it('drop-after-digest: the local copy is evicted once the note is digested, and fetched back on demand', async () => {
    const { brain, pipeline, storage } = await run('drop-after-digest')
    await settled(brain, NOTE_ID)
    await pipeline.idle()
    expect(storage.isCached(OWNER_ID, NOTE_ID, 'audio.webm')).toBe(false)
    expect(storage.remoteFetches).toBe(0) // the transcription read the copy cached since the upload
    const found = await brain.store.audio((await brain.store.meta(NOTE_ID))!) // playback
    expect(Array.from(await readAll(found!.stream))).toEqual(Array.from(AUDIO))
    expect(storage.remoteFetches).toBe(1) // playback had to go and get it
    expect(brain.search('bank')[0]?.ref).toBe(NOTE_ID) // and nothing about the note changed
  })

  it('drop-after-digest: the audio is held until the digest exists, so a model outage does not lose the way back', async () => {
    const { brain, pipeline, storage } = await run('drop-after-digest', { llm: null })
    await waitFor(() => brain.index.note(NOTE_ID), 'the note to be transcribed and filed')
    await pipeline.idle()
    expect(brain.index.note(NOTE_ID)?.digested).toBe(0)
    expect(storage.isCached(OWNER_ID, NOTE_ID, 'audio.webm')).toBe(true)
  })

  it('does not mark a note failed when the release itself fails', async () => {
    const booted = await boot(new MemoryStorage({ retainAudio: 'drop-after-digest' }))
    booted.storage.releaseAudio = async () => { throw new Error('the cache is on fire') }
    await booted.brain.store.saveUpload(meta(NOTE_ID), AUDIO, 'webm')
    booted.pipeline.kick()
    await settled(booted.brain, NOTE_ID)
    await booted.pipeline.idle()
    expect(await booted.pipeline.status()).toMatchObject({ failed: [] })
  })
})
