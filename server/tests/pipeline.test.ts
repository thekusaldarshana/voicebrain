import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.ts'
import { CREATED_AT, DIGEST, NOTE_ID, TRANSCRIPT, fakeLlm, fakeStt, run, tempDir, testConfig, upload, waitFor, type Fake, type Running } from './helpers.ts'

const exec = promisify(execFile)
const NOTE_PATH = 'notes/2026/10/2026-10-30-0912-3f2b1c0e.md'

let dir: Awaited<ReturnType<typeof tempDir>>
let stt: Fake
let llm: Fake
let server: Running | null = null
const withProviders = (extra: Partial<Config> = {}) => testConfig(dir.dir, { stt: { provider: 'openai', baseUrl: stt.url, apiKey: 'k', model: 'whisper-test', language: 'en', maxMb: 24, prompt: '' }, llm: { baseUrl: llm.url, apiKey: 'k', model: 'llm-test', maxInputChars: 20_000 }, ...extra })
const read = (rel: string) => readFile(join(dir.dir, rel), 'utf8')
const digested = (id = NOTE_ID) => () => server?.app.brain.index.note(id)?.digested === 1
/** Waits for the note to be digested, then for the pass that filed it to finish writing everything. */
const settled = async (id: string = NOTE_ID, what = 'the note to be digested and filed') => { await waitFor(digested(id), what); await server?.app.pipeline.idle() }

beforeEach(async () => { dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm() })
afterEach(async () => { await server?.stop(); server = null; await stt.close(); await llm.close(); await dir.clean() })

describe('from upload to a searchable, versioned note', () => {
  it('transcribes, digests, files, indexes and commits', async () => {
    server = await run(withProviders())
    expect((await upload(server.base)).status).toBe(201)
    await settled(undefined, 'the note to be digested and filed')

    const transcript = JSON.parse(await read(`inbox/${NOTE_ID}/transcript.json`))
    expect(transcript).toMatchObject({ text: TRANSCRIPT, model: 'whisper-test', suspectedSilence: false })
    const digest = JSON.parse(await read(`inbox/${NOTE_ID}/digest.json`))
    expect(digest.tasks).toHaveLength(1)
    expect(digest.tasks[0]).toMatchObject({ text: 'Call the bank', due: '2026-10-31' })
    expect(digest.droppedItems).toBe(1) // the invented dentist task never made it in

    const note = await read(`vault/${NOTE_PATH}`)
    expect(note).toContain('- [ ] Call the bank · due 2026-10-31')
    expect(note).not.toContain('dentist')
    expect(note).toContain('`00:08`') // the mark, with the words spoken there
    expect(await read('vault/daily/2026-10-30.md')).toContain('Bank call and weekly review idea')
    expect(await read('vault/tasks.md')).toContain('Call the bank')
    expect(await read('vault/projects/trapper.md')).toContain('Trapper')
    expect(await read('vault/people/nimal.md')).toContain('Nimal')

    const { brain } = server.app
    expect(brain.search('bank')[0]?.ref).toBe(NOTE_ID)
    expect(brain.search('weekly review')[0]?.ref).toBe(NOTE_ID)

    const log = (await exec('git', ['log', '--format=%s'], { cwd: join(dir.dir, 'vault') })).stdout
    expect(log).toContain('2026-10-30 09:12 Bank call and weekly review idea')
    const status = (await exec('git', ['status', '--porcelain'], { cwd: join(dir.dir, 'vault') })).stdout
    expect(status).toBe('')

    expect(stt.requests[0]?.fields).toMatchObject({ model: 'whisper-test', language: 'en', response_format: 'verbose_json' })
    expect(llm.requests).toHaveLength(1)
  })

  it('teaches the model names it has seen before', async () => {
    server = await run(withProviders())
    await upload(server.base)
    await settled(undefined, 'first note')
    const second = '44444444-4444-4444-8444-444444444444'
    await upload(server.base, { id: second, createdAt: '2026-10-31T03:00:00.000Z' })
    await settled(second, 'second note')
    expect(llm.requests[1]?.json.messages[1].content).toContain('KNOWN projects: Trapper')
    expect(llm.requests[1]?.json.messages[1].content).toContain('KNOWN people: Nimal')
  })

  it('answers a brief with the related note, task and project', async () => {
    server = await run(withProviders())
    await upload(server.base)
    await settled(undefined, 'note')
    const brief = server.app.brain.brief('should I add a review screen to Trapper?')
    expect(brief.notes.map(hit => hit.ref)).toContain(NOTE_ID)
    expect(brief.entities.some(entity => entity.name === 'Trapper')).toBe(true)
    const general = server.app.brain.brief('')
    expect(general.notes.length).toBeGreaterThan(0)
  })
})

describe('when things go wrong', () => {
  it('retries a transcription service that is briefly down, then succeeds', async () => {
    stt.respond(index => (index < 2 ? { status: 503, body: 'busy' } : null))
    server = await run(withProviders())
    await upload(server.base)
    await settled(undefined, 'recovery after two failures')
    expect(stt.requests.length).toBe(3)
    expect(JSON.parse(await read(`inbox/${NOTE_ID}/state.json`))).toMatchObject({ attempts: 0, failed: false, lastError: null })
  })

  it('stops on a rejected key, shows it in status, and resumes after a retry', async () => {
    stt.respond(() => ({ status: 401, body: 'bad key' }))
    server = await run(withProviders())
    await upload(server.base)
    const state = await waitFor(async () => { const s = JSON.parse(await read(`inbox/${NOTE_ID}/state.json`).catch(() => '{}')); return s.failed ? s : null }, 'failure to be recorded')
    expect(state).toMatchObject({ failed: true, stage: 'transcribe' })
    expect(state.lastError).toContain('401')
    const callsBefore = stt.requests.length
    await new Promise(done => setTimeout(done, 300))
    expect(stt.requests.length).toBe(callsBefore) // no hammering a rejected key

    const status = (await (await fetch(`${server.base}/v1/status`, { headers: { Authorization: 'Bearer test-ingest-token-123' } })).json()) as { failed: Array<{ id: string }> }
    expect(status.failed).toHaveLength(1)
    expect(status.failed[0]?.id).toBe(NOTE_ID)

    stt.respond(() => null)
    const retry = await fetch(`${server.base}/v1/notes/${NOTE_ID}/retry`, { method: 'POST', headers: { Authorization: 'Bearer test-ingest-token-123' } })
    expect(retry.status).toBe(202)
    await settled(undefined, 'processing after retry')
  })

  it('still files a searchable transcript when the language model is down, and digests it later', async () => {
    llm.respond(() => ({ status: 500, body: 'down' }))
    server = await run(withProviders({ maxAttempts: 50 }))
    await upload(server.base)
    await waitFor(() => server?.app.brain.index.note(NOTE_ID), 'transcript to be filed')
    expect(server.app.brain.search('bank')[0]?.ref).toBe(NOTE_ID)
    expect(await read(`vault/${NOTE_PATH}`)).toContain('Summary and tasks have not been extracted yet')
    expect(server.app.brain.index.note(NOTE_ID)?.digested).toBe(0)
    llm.respond(() => null)
    await settled(undefined, 'digest once the model is back')
    expect(await read(`vault/${NOTE_PATH}`)).toContain('digested: true')
  })

  it('keeps notes safe until providers are configured, then processes them after a restart', async () => {
    server = await run(testConfig(dir.dir)) // no STT, no LLM
    await upload(server.base)
    await new Promise(done => setTimeout(done, 200))
    expect(existsSync(join(dir.dir, 'inbox', NOTE_ID, 'audio.webm'))).toBe(true)
    expect(existsSync(join(dir.dir, 'inbox', NOTE_ID, 'transcript.json'))).toBe(false)
    const status = await server.app.pipeline.status()
    expect(status.waiting).toBe(1)
    expect(status.needs.join(' ')).toMatch(/STT_BASE_URL.*LLM_BASE_URL/s)
    await server.stop()
    server = await run(withProviders())
    await settled(undefined, 'processing after configuration')
  })

  it('does not ask the language model to read an empty recording', async () => {
    stt.respond(() => ({ body: { text: 'Thank you.', segments: [] } }))
    server = await run(withProviders())
    await upload(server.base)
    await settled(undefined, 'silent note to be filed')
    expect(llm.requests).toHaveLength(0)
    expect(await read(`vault/${NOTE_PATH}`)).toContain('Possibly no speech')
  })

  it('gives up cleanly after too many failures', async () => {
    stt.respond(() => ({ status: 500, body: 'always down' }))
    server = await run(withProviders({ maxAttempts: 3 }))
    await upload(server.base)
    const state = await waitFor(async () => { const s = JSON.parse(await read(`inbox/${NOTE_ID}/state.json`).catch(() => '{}')); return s.failed ? s : null }, 'giving up')
    expect(state.attempts).toBe(3)
  })
})

describe('the index is disposable, the files are not', () => {
  it('rebuilds search from the inbox after the index is lost', async () => {
    server = await run(withProviders())
    await upload(server.base)
    await settled(undefined, 'note')
    await server.stop()
    await Promise.all(['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm'].map(name => rm(join(dir.dir, name), { force: true })))
    server = await run(withProviders())
    expect(server.app.brain.search('bank')[0]?.ref).toBe(NOTE_ID)
    expect(server.app.brain.openLoops()).toHaveLength(1)
  })

  it('remembers done tasks across a rebuild, in the vault and in git', async () => {
    server = await run(withProviders())
    await upload(server.base)
    await settled(undefined, 'note')
    const done = await server.app.brain.updateTask(`${NOTE_ID}#0`, 'done')
    expect(done?.status).toBe('done')
    expect(await read(`vault/${NOTE_PATH}`)).toContain('- [x] Call the bank')
    expect(await read('vault/tasks.md')).not.toContain('Call the bank')
    expect(server.app.brain.openLoops()).toEqual([])
    expect(await server.app.brain.updateTask(`${NOTE_ID}#9`, 'done')).toBeNull()
    await server.stop()
    await Promise.all(['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm'].map(name => rm(join(dir.dir, name), { force: true })))
    server = await run(withProviders())
    expect(server.app.brain.openLoops()).toEqual([])
    expect(JSON.parse(await read('vault/state/task-status.json'))[`${NOTE_ID}#0`].status).toBe('done')
    const log = (await exec('git', ['log', '--format=%s'], { cwd: join(dir.dir, 'vault') })).stdout
    expect(log).toContain('task done: Call the bank')
  })
})

describe('notes written in chat and the wiki', () => {
  it('processes a text note like a spoken one', async () => {
    llm = await (async () => { await llm.close(); return fakeLlm({ title: 'Passport', summary: 'Renew the passport.', tasks: [{ text: 'Renew passport', due: null, project: null, priority: 'normal', quote: 'renew my passport' }], ideas: [], decisions: [], questions: [], people: [], projects: [], tags: [] }) })()
    server = await run(withProviders())
    const id = await server.app.brain.addTextNote('I need to renew my passport before March.', '')
    expect(server.app.brain.search('passport')[0]?.ref).toBe(id) // searchable immediately
    await settled(id, 'text note to be digested')
    expect(server.app.brain.openLoops()[0]?.text).toBe('Renew passport')
    expect(stt.requests).toHaveLength(0)
  })

  it('writes, appends, searches and protects wiki pages', async () => {
    server = await run(withProviders())
    const { brain } = server.app
    await brain.wikiWrite('projects/trapper.md', '# Trapper\nTime budgeting app.', 'replace')
    await brain.wikiWrite('wiki/projects/trapper.md', 'Weekly review idea from [[notes/2026/10/x]].', 'append')
    const page = await brain.wikiRead('projects/trapper.md')
    expect(page).toContain('Time budgeting app.')
    expect(page).toContain('Weekly review idea')
    expect(brain.search('budgeting')[0]).toMatchObject({ kind: 'wiki', ref: 'wiki/projects/trapper.md', title: 'Trapper' })
    expect(brain.wikiList()).toContain('wiki/projects/trapper.md')
    for (const bad of ['../x.md', 'a/../../b.md', '/etc/passwd', 'notes.txt', '.hidden/x.md', 'a/b/c/d/e.md', 'x'.repeat(5) + '/../y.md']) await expect(brain.wikiWrite(bad, 'x', 'replace')).rejects.toThrow()
    await expect(brain.wikiWrite('big.md', 'x'.repeat(250_000), 'replace')).rejects.toThrow(/over 200 KB/)
    const log = (await exec('git', ['log', '--format=%s'], { cwd: join(dir.dir, 'vault') })).stdout
    expect(log).toContain('wiki: replace wiki/projects/trapper.md')
  })

  it('notices wiki pages edited outside the server', async () => {
    server = await run(withProviders())
    await writeFile(join(dir.dir, 'vault', 'wiki', 'hand-written.md'), '# Hand written\nAbout kayaking.\n')
    await server.app.brain.syncWiki()
    expect(server.app.brain.search('kayaking')[0]?.ref).toBe('wiki/hand-written.md')
    await rm(join(dir.dir, 'vault', 'wiki', 'hand-written.md'))
    await server.app.brain.syncWiki()
    expect(server.app.brain.search('kayaking')).toEqual([])
  })
})

describe('what the recorder app sees', () => {
  it('says the note is stored the moment it is, and 409 for a repeat', async () => {
    server = await run(testConfig(dir.dir))
    expect((await upload(server.base)).status).toBe(201)
    const again = await upload(server.base)
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true })
    expect(CREATED_AT).toBeTruthy()
    expect(DIGEST.title).toBeTruthy()
  })
})
