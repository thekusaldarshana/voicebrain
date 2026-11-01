import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Index } from '../src/index.ts'
import type { Config } from '../src/config.ts'
import { DIGEST, INGEST, NOTE_ID, fakeLlm, fakeStt, run, tempDir, testConfig, upload, waitFor, type Fake, type Running } from './helpers.ts'

const auth = { Authorization: `Bearer ${INGEST}`, 'Content-Type': 'application/json' }
let dir: Awaited<ReturnType<typeof tempDir>>
let stt: Fake
let llm: Fake
let server: Running
const withProviders = (): Config => testConfig(dir.dir, { stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'whisper-test', language: 'en', maxMb: 24, prompt: '' }, llm: { baseUrl: llm.url, apiKey: '', model: 'llm-test', maxInputChars: 20_000 } })
const settled = async () => { await waitFor(() => server.app.brain.index.note(NOTE_ID)?.digested === 1, 'digest'); await server.app.pipeline.idle() }
const listed = async () => ((await (await fetch(`${server.base}/v1/notes`, { headers: auth })).json()) as { notes: Array<{ id: string; title: string; userTitle: string; drive: string | null }> }).notes

beforeEach(async () => { dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm(); server = await run(withProviders()) })
afterEach(async () => { await server.stop(); await stt.close(); await llm.close(); await dir.clean() })

describe('GET /v1/notes: the names the app shows', () => {
  it('needs a token', async () => {
    expect((await fetch(`${server.base}/v1/notes`)).status).toBe(401)
  })

  it('lists the model’s title, then the assistant’s rename, with no name of the person’s own', async () => {
    await upload(server.base)
    await settled()
    expect(await listed()).toEqual([{ id: NOTE_ID, title: DIGEST.title, userTitle: '', drive: null }])
    expect(await server.app.brain.editNote(NOTE_ID, { title: 'Rutherford and the gold foil' }, 'assistant')).toMatchObject({ applied: true })
    expect(await listed()).toEqual([{ id: NOTE_ID, title: 'Rutherford and the gold foil', userTitle: '', drive: null }])
  })

  it('shows the person’s own name as theirs, and the assistant can no longer replace it', async () => {
    await upload(server.base)
    await settled()
    await fetch(`${server.base}/v1/notes/${NOTE_ID}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ title: 'My name' }) })
    expect(await listed()).toEqual([{ id: NOTE_ID, title: 'My name', userTitle: 'My name', drive: null }])
    expect(await server.app.brain.editNote(NOTE_ID, { title: 'Assistant tries' }, 'assistant')).toMatchObject({ applied: false })
    expect((await listed())[0]).toMatchObject({ title: 'My name', userTitle: 'My name' })
  })

  it('counts a title typed in the recorder as the person’s own, and forgets a deleted note', async () => {
    await upload(server.base, { extra: { title: 'Call with the bank' } })
    await settled()
    expect((await listed())[0]).toMatchObject({ title: 'Call with the bank', userTitle: 'Call with the bank' })
    expect((await fetch(`${server.base}/v1/notes/${NOTE_ID}`, { method: 'DELETE', headers: auth })).status).toBe(204)
    expect(await listed()).toEqual([])
  })
})

describe('an index from before names were kept', () => {
  it('says so, so the server rebuilds it once', async () => {
    await upload(server.base)
    await settled()
    const path = join(dir.dir, 'index.sqlite')
    await server.stop()
    const index = new Index(path)
    expect(index.namesComplete()).toBe(true)
    // Make it look like the old schema: the notes are there, the names are not.
    ;(index as unknown as { db: { exec(sql: string): void } }).db.exec('DELETE FROM note_names')
    expect(index.namesComplete()).toBe(false)
    index.close()
    server = await run(withProviders())
    await waitFor(() => server.app.brain.index.namesComplete(), 'names rebuilt at start')
    expect((await listed())[0]).toMatchObject({ id: NOTE_ID, title: DIGEST.title })
  })
})
