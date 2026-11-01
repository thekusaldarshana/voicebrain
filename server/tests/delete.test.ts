import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import { INGEST, NOTE_ID, TRANSCRIPT, fakeLlm, fakeStt, run, tempDir, testConfig, upload, waitFor, type Fake, type Running } from './helpers.ts'

const exec = promisify(execFile)
const SECOND = '44444444-4444-4444-8444-444444444444'
const auth = { Authorization: `Bearer ${INGEST}` }

let dir: Awaited<ReturnType<typeof tempDir>>
let stt: Fake
let llm: Fake
let server: Running
const withProviders = (extra: Partial<Config> = {}) => testConfig(dir.dir, { stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'whisper-test', language: 'en', maxMb: 24, prompt: '' }, llm: { baseUrl: llm.url, apiKey: '', model: 'llm-test', maxInputChars: 20_000 }, ...extra })
const settled = async (id: string) => { await waitFor(() => server.app.brain.index.note(id)?.digested === 1, `note ${id.slice(0, 8)} to be digested`); await server.app.pipeline.idle() }
const remove = (id: string, headers: Record<string, string> = auth) => fetch(`${server.base}/v1/notes/${id}`, { method: 'DELETE', headers })
const exists = (...parts: string[]) => existsSync(join(dir.dir, ...parts))

beforeEach(async () => { dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm(); server = await run(withProviders()) })
afterEach(async () => { await server.stop(); await stt.close(); await llm.close(); await dir.clean() })

describe('deleting a note from the server', () => {
  it('removes everything about it and says so plainly', async () => {
    await upload(server.base)
    await settled(NOTE_ID)
    await server.app.brain.updateTask(`${NOTE_ID}#0`, 'done')
    expect(exists('inbox', NOTE_ID, 'audio.webm')).toBe(true)
    expect(exists('vault', 'notes', '2026', '10', '2026-10-30-0912-3f2b1c0e.md')).toBe(true)

    expect((await remove(NOTE_ID, {})).status).toBe(401) // needs a token
    expect(exists('inbox', NOTE_ID)).toBe(true)
    expect((await remove(NOTE_ID)).status).toBe(204)

    expect(exists('inbox', NOTE_ID)).toBe(false) // audio, transcript, digest, edits: all gone
    expect(exists('vault', 'notes', '2026', '10', '2026-10-30-0912-3f2b1c0e.md')).toBe(false)
    expect(exists('vault', 'daily', '2026-10-30.md')).toBe(false) // the only note that day
    expect(exists('vault', 'projects', 'trapper.md')).toBe(false) // its only mention
    expect(exists('vault', 'people', 'nimal.md')).toBe(false)
    expect(await readFile(join(dir.dir, 'vault', 'tasks.md'), 'utf8')).not.toContain('Call the bank')
    expect(server.app.brain.search('bank')).toEqual([])
    expect(server.app.brain.openLoops()).toEqual([])
    expect(JSON.parse(await readFile(join(dir.dir, 'vault', 'state', 'task-status.json'), 'utf8'))).toEqual({}) // its task status too
    expect((await server.app.pipeline.status()).notes).toBe(0)
  })

  it('answers 404 for a note that is already gone or never existed', async () => {
    await upload(server.base)
    await settled(NOTE_ID)
    expect((await remove(NOTE_ID)).status).toBe(204)
    expect((await remove(NOTE_ID)).status).toBe(404)
    expect((await remove('55555555-5555-4555-8555-555555555555')).status).toBe(404)
    expect((await remove('not-an-id')).status).toBe(404)
    expect((await remove('..%2F..%2Fetc')).status).toBe(404)
  })

  it('leaves other notes alone and rewrites the pages they share', async () => {
    await upload(server.base)
    await settled(NOTE_ID)
    await upload(server.base, { id: SECOND, createdAt: '2026-10-30T05:00:00.000Z' }) // same day, same project
    await settled(SECOND)
    expect(await readFile(join(dir.dir, 'vault', 'projects', 'trapper.md'), 'utf8')).toContain('2 mentions')
    expect((await remove(NOTE_ID)).status).toBe(204)
    expect(exists('vault', 'notes', '2026', '10', '2026-10-30-1030-44444444.md')).toBe(true)
    expect(exists('vault', 'daily', '2026-10-30.md')).toBe(true)
    expect(await readFile(join(dir.dir, 'vault', 'daily', '2026-10-30.md'), 'utf8')).not.toContain('09:12')
    expect(await readFile(join(dir.dir, 'vault', 'projects', 'trapper.md'), 'utf8')).toContain('1 mention')
    expect(server.app.brain.search('bank')[0]?.ref).toBe(SECOND)
  })

  it('leaves no copy of the note in git history', async () => {
    await upload(server.base)
    await settled(NOTE_ID)
    await server.app.brain.updateTask(`${NOTE_ID}#0`, 'done')
    await remove(NOTE_ID)
    const history = (await exec('git', ['log', '-p', '--all'], { cwd: join(dir.dir, 'vault') })).stdout
    for (const secret of ['Bank call', 'call the bank', 'Nimal', TRANSCRIPT.slice(0, 20)]) expect(history, secret).not.toContain(secret)
  })

  it('survives a restart: the note does not come back from the index', async () => {
    await upload(server.base)
    await settled(NOTE_ID)
    await remove(NOTE_ID)
    const config = server.app.brain.config
    await server.stop()
    server = await run(config)
    expect(server.app.brain.search('bank')).toEqual([])
    expect(server.app.brain.index.noteCount()).toBe(0)
  })

  it('does not bring a note back when it is deleted while still being transcribed', async () => {
    stt.respond(() => ({ body: { text: TRANSCRIPT, segments: [] }, delayMs: 500 }))
    await upload(server.base)
    await waitFor(() => stt.requests.length === 1, 'the transcription to start')
    expect((await remove(NOTE_ID)).status).toBe(204)
    await new Promise(done => setTimeout(done, 800)) // the transcription finishes after the delete
    await server.app.pipeline.idle()
    expect(exists('inbox', NOTE_ID)).toBe(false) // not even a leftover folder
    expect(server.app.brain.index.note(NOTE_ID)).toBeUndefined()
    expect(exists('vault', 'notes', '2026', '10', '2026-10-30-0912-3f2b1c0e.md')).toBe(false)
    const status = await server.app.pipeline.status()
    expect(status).toMatchObject({ notes: 0, failed: [] }) // and it is not reported as a failure
    expect(llm.requests).toHaveLength(0)
  })

  it('is not offered to the assistant: it cannot delete notes', async () => {
    const tools = (await import('../src/mcp.ts')).createMcpServer(server.app.brain) as unknown as { _registeredTools: Record<string, unknown> }
    expect(Object.keys(tools._registeredTools).some(name => /delete|remove/.test(name))).toBe(false)
  })
})
