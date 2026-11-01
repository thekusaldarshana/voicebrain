import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Brain } from '../src/brain.ts'
import type { Config } from '../src/config.ts'
import { INGEST, NOTE_ID, fakeLlm, fakeStt, run, tempDir, testConfig, upload, waitFor, type Fake, type Running } from './helpers.ts'

const exec = promisify(execFile)
const SECOND = '44444444-4444-4444-8444-444444444444'
const THIRD = '66666666-6666-4666-8666-666666666666'
const SERVER_DIR = join(import.meta.dirname, '..')

let dir: Awaited<ReturnType<typeof tempDir>>
let stt: Fake
let llm: Fake
let server: Running
const withProviders = (extra: Partial<Config> = {}) => testConfig(dir.dir, { stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'whisper-test', language: 'en', maxMb: 24, prompt: '' }, llm: { baseUrl: llm.url, apiKey: '', model: 'llm-test', maxInputChars: 20_000 }, ...extra })
const settled = async (id: string) => { await waitFor(() => server.app.brain.index.note(id)?.digested === 1, `note ${id.slice(0, 8)} to be digested`); await server.app.pipeline.idle() }
const GENERATED = ['notes', 'daily', 'projects', 'people']

/** Every generated vault file by path, plus the whole index as plain rows. */
async function snapshot(brain: Brain): Promise<{ files: Record<string, string>; index: Record<string, unknown[]> }> {
  const files: Record<string, string> = {}
  for (const root of GENERATED) for (const path of await brain.vault.listMarkdown(root)) files[path] = (await brain.vault.read(path)) as string
  files['tasks.md'] = (await brain.vault.read('tasks.md')) as string
  const rows = (sql: string) => brain.index.db.prepare(sql).all() as unknown[]
  return {
    files,
    index: {
      notes: rows('SELECT * FROM notes ORDER BY id'),
      tasks: rows('SELECT * FROM tasks ORDER BY id'),
      task_status: rows('SELECT * FROM task_status ORDER BY id'),
      entities: rows('SELECT * FROM entities ORDER BY kind, slug, note_id, name, context'),
      wiki: rows('SELECT path, title FROM wiki ORDER BY path'),
      docs: rows('SELECT kind, ref, title, body FROM docs ORDER BY kind, ref'),
    },
  }
}

const dropIndex = () => Promise.all(['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm'].map(name => rm(join(dir.dir, name), { force: true })))
const dropGenerated = async () => { for (const path of [...GENERATED, 'tasks.md']) await rm(join(dir.dir, 'vault', path), { recursive: true, force: true }) }
const reindexCli = () => exec(process.execPath, ['src/main.ts', 'reindex'], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: dir.dir, INGEST_TOKEN: INGEST, GIT: '0' } })

beforeEach(async () => { dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm(); server = await run(withProviders()) })
afterEach(async () => { await server.stop(); await stt.close(); await llm.close(); await dir.clean() })

async function fillTheKnowledgeBase() {
  await upload(server.base)
  await settled(NOTE_ID)
  await upload(server.base, { id: SECOND, createdAt: '2026-10-30T05:00:00.000Z' }) // same day, same project and person
  await settled(SECOND)
  await upload(server.base, { id: THIRD, createdAt: '2026-10-29T08:15:00.000Z', marks: [] }) // another day
  await settled(THIRD)
  await server.app.brain.updateTask(`${NOTE_ID}#0`, 'done')
  await server.app.brain.updateTask(`${SECOND}#1`, 'dismissed')
  await server.app.brain.editNote(SECOND, { title: 'Bank errands', tags: ['money'] }, 'user')
  await server.app.brain.wikiWrite('projects/trapper.md', '# Trapper\nThe assistant\'s own page about budgeting.', 'replace')
  const textId = await server.app.brain.addTextNote('Remember to renew the passport.', 'Passport')
  await settled(textId)
  return textId
}

describe('reindex: the index and the generated pages are disposable', () => {
  it('rebuilds the vault pages and the search index from the stored notes, with identical output', async () => {
    await fillTheKnowledgeBase()
    const before = await snapshot(server.app.brain)
    expect(Object.keys(before.files).length).toBeGreaterThan(6) // notes, daily pages, project and person pages, tasks.md
    expect(before.index.notes).toHaveLength(4)
    const searches = ['bank', 'trapper', 'passport', 'weekly review'].map(query => server.app.brain.search(query))
    const wikiBefore = await readFile(join(dir.dir, 'vault', 'wiki', 'projects', 'trapper.md'), 'utf8')
    const statusBefore = await readFile(join(dir.dir, 'vault', 'state', 'task-status.json'), 'utf8')

    await server.stop()
    await dropIndex()
    await dropGenerated()
    expect(await readdir(join(dir.dir, 'vault'))).not.toContain('notes')
    const output = await reindexCli()
    expect(output.stdout).toMatch(/reindexed 4 notes, wrote \d+ vault pages/)

    server = await run(withProviders())
    const after = await snapshot(server.app.brain)
    expect(after.files).toEqual(before.files)
    expect(after.index).toEqual(before.index)
    expect(['bank', 'trapper', 'passport', 'weekly review'].map(query => server.app.brain.search(query))).toEqual(searches)
    // what is not derived was never touched
    expect(await readFile(join(dir.dir, 'vault', 'wiki', 'projects', 'trapper.md'), 'utf8')).toBe(wikiBefore)
    expect(await readFile(join(dir.dir, 'vault', 'state', 'task-status.json'), 'utf8')).toBe(statusBefore)
    expect(await server.app.brain.getNote(NOTE_ID)).not.toBeNull() // pages are served again
  })

  it('gives the same result when run twice, in the running server', async () => {
    await fillTheKnowledgeBase()
    const before = await snapshot(server.app.brain)
    expect(await server.app.brain.reindex()).toMatchObject({ notes: 4 })
    expect(await snapshot(server.app.brain)).toEqual(before)
    await server.app.brain.reindex()
    expect(await snapshot(server.app.brain)).toEqual(before)
  })

  it('removes generated pages that no stored note explains, and never touches wiki/ or state/', async () => {
    await upload(server.base)
    await settled(NOTE_ID)
    const vault = (...parts: string[]) => join(dir.dir, 'vault', ...parts)
    await mkdir(vault('notes', '2020', '01'), { recursive: true })
    await writeFile(vault('notes', '2020', '01', 'ghost.md'), 'a page whose note is gone')
    await writeFile(vault('daily', '1999-01-01.md'), 'ghost day')
    await writeFile(vault('people', 'ghost.md'), 'ghost person')
    await writeFile(vault('wiki', 'mine.md'), '# Mine\nkeep me')
    await server.app.brain.reindex()
    for (const ghost of [['notes', '2020', '01', 'ghost.md'], ['daily', '1999-01-01.md'], ['people', 'ghost.md']]) await expect(readFile(vault(...ghost))).rejects.toThrow()
    expect(await readFile(vault('wiki', 'mine.md'), 'utf8')).toContain('keep me')
    expect(await server.app.brain.getNote(NOTE_ID)).not.toBeNull()
    expect(server.app.brain.search('keep me', 5, 'wiki')[0]?.ref).toBe('wiki/mine.md')
  })

  it('skips a note that has no transcript yet, exactly as filing does', async () => {
    await server.stop()
    server = await run(withProviders({ stt: null })) // accepts uploads, cannot transcribe
    await upload(server.base)
    expect(await server.app.brain.reindex()).toEqual({ notes: 0, pages: 1 }) // only tasks.md
    expect(server.app.brain.index.noteCount()).toBe(0)
    expect(await server.app.brain.store.has(NOTE_ID)).toBe(true) // still stored, waiting
  })
})
