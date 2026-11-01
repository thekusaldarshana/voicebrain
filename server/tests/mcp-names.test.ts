import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { friendlyDay, fullDay } from '../src/mcp.ts'
import { DIGEST, INGEST, NOTE_ID, fakeLlm, fakeStt, run, tempDir, testConfig, upload, waitFor, type Fake, type Running } from './helpers.ts'

const SECOND = '44444444-4444-4444-8444-444444444444'
const TOKEN = 'static-mcp-token-0123456789'
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

let dir: Awaited<ReturnType<typeof tempDir>>
let stt: Fake
let llm: Fake
let server: Running
let client: Client

const settled = async (id: string) => { await waitFor(() => server.app.brain.index.note(id)?.digested === 1, `note ${id.slice(0, 8)}`); await server.app.pipeline.idle() }
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return { text: (result.content as Array<{ text: string }>).map(part => part.text).join('\n'), isError: result.isError === true }
}
const rename = (id: string, title: string) => fetch(`${server.base}/v1/notes/${id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${INGEST}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) })

beforeEach(async () => {
  dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm()
  server = await run(testConfig(dir.dir, {
    mcpToken: TOKEN,
    stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'w', language: 'en', maxMb: 24, prompt: '' },
    llm: { baseUrl: llm.url, apiKey: '', model: 'l', maxInputChars: 20_000 },
  }))
  await upload(server.base)
  await settled(NOTE_ID)
  client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
})
afterEach(async () => { await client.close(); await server.stop(); await stt.close(); await llm.close(); await dir.clean() })

describe('notes are named for people, not for the database', () => {
  it('shows titles and dates, and keeps ids out of sight', async () => {
    for (const [tool, args] of [['brief', { topic: 'bank' }], ['search', { query: 'bank' }], ['recent', {}], ['open_loops', {}]] as const) {
      const { text } = await call(tool, args)
      expect(text, tool).toContain(`“${DIGEST.title}”`)
      expect(text, tool).not.toMatch(UUID_ANYWHERE)
      expect(text, tool).not.toMatch(/\[[0-9a-f]{8}\]/) // no bracketed ids
      expect(text, tool).toMatch(/\(ref [0-9a-f]{8}(#\d)?\)/) // the code is there for tools, in plain parentheses
    }
  })

  it('reads a note by its title, a part of it, or its ref', async () => {
    for (const note of [DIGEST.title, 'weekly review idea', 'BANK CALL', '3f2b1c0e']) {
      const { text, isError } = await call('get_note', { note })
      expect(isError, note).toBe(false)
      expect(text, note).toContain('## Transcript')
      expect(text, note).toContain('Remind me to call the bank tomorrow.')
    }
    const note = (await call('get_note', { note: DIGEST.title })).text
    expect(note).toMatch(/^Recorded .*09:12 · 11s\n/)
    expect(note).not.toContain('id: "3f2b1c0e') // no machine header
    expect(note).toMatch(/^Recorded [^\n]+\n\n# /) // starts with the title, not with a metadata block
    expect((await call('get_note', { id: 'bank call' })).isError).toBe(false) // the old argument name still works
  })

  it('says what it could not find, and asks which one when two notes match', async () => {
    expect((await call('get_note', { note: 'zebra migration' })).text).toContain('No note matches “zebra migration”')
    await upload(server.base, { id: SECOND, createdAt: '2026-10-31T03:00:00.000Z' })
    await settled(SECOND) // the same words, so the same title
    const ambiguous = await call('get_note', { note: DIGEST.title })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toContain('More than one note matches')
    expect(ambiguous.text.match(new RegExp(`“${DIGEST.title}” — `, 'g'))).toHaveLength(2)
    expect(ambiguous.text).toMatch(/Fri 30 Oct.*09:12/s)
    expect(ambiguous.text).toMatch(/(Sat 31 Oct|yesterday).*08:30/s) // the day reads "yesterday" or by name, depending on when the test runs
    expect(ambiguous.text).not.toMatch(UUID_ANYWHERE)
    await rename(SECOND, 'The second bank call')
    expect((await call('get_note', { note: 'second bank' })).isError).toBe(false)
    expect((await call('get_note', { note: DIGEST.title })).isError).toBe(false)
  })
})

describe('tasks are found by what they say', () => {
  it('marks a task from words in it', async () => {
    expect((await call('update_task', { task: 'call the bank', status: 'done' })).text).toBe('Marked “Call the bank” as done.')
    expect((await call('open_loops')).text).toBe('No open tasks.')
    expect((await call('update_task', { task: 'CALL THE BANK', status: 'open' })).text).toBe('Marked “Call the bank” as open.')
    expect((await call('update_task', { task: 'nothing like this', status: 'done' })).isError).toBe(true)
  })

  it('asks which task when words match several', async () => {
    await upload(server.base, { id: SECOND, createdAt: '2026-10-31T03:00:00.000Z' })
    await settled(SECOND)
    const result = await call('update_task', { task: 'call the bank', status: 'done' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('More than one task matches')
    expect(result.text).not.toMatch(UUID_ANYWHERE)
    expect((await call('update_task', { task: '3f2b1c0e#0', status: 'done' })).isError).toBe(false) // a ref still picks exactly one
  })
})

describe('the assistant naming notes', () => {
  it('renames a note and finds it by the new name', async () => {
    const done = await call('rename_note', { note: DIGEST.title, title: 'Bank call and weekly review' })
    expect(done).toEqual({ text: 'Renamed to “Bank call and weekly review”.', isError: false })
    expect((await call('search', { query: 'weekly review' })).text).toContain('“Bank call and weekly review”')
  })

  it('leaves a title the user chose alone, and says so', async () => {
    await rename(NOTE_ID, 'My own name for it')
    const refused = await call('rename_note', { note: 'My own name', title: 'Something the assistant prefers' })
    expect(refused.isError).toBe(false)
    expect(refused.text).toBe('The user named this note “My own name for it”, so I left the title as it is.')
    expect(server.app.brain.index.note(NOTE_ID)?.title).toBe('My own name for it')
  })
})

describe('what ChatGPT is told', () => {
  it('has every hint set, and only marks a tool read-only when it changes nothing', async () => {
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name).sort()).toEqual(['add_note', 'brief', 'get_note', 'list_wiki', 'notes_to_process', 'open_loops', 'read_wiki', 'recent', 'rename_note', 'save_digest', 'search', 'update_task', 'write_wiki'])
    const readOnly = new Set(['brief', 'search', 'recent', 'get_note', 'open_loops', 'list_wiki', 'read_wiki', 'notes_to_process'])
    for (const tool of tools) {
      const hints = tool.annotations
      for (const key of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) expect(typeof hints?.[key], `${tool.name}.${key}`).toBe('boolean')
      expect(hints?.readOnlyHint, tool.name).toBe(readOnly.has(tool.name))
      expect(hints?.openWorldHint, tool.name).toBe(false)
      if (readOnly.has(tool.name)) expect(hints?.destructiveHint, tool.name).toBe(false)
    }
    expect(tools.find(tool => tool.name === 'write_wiki')?.annotations?.destructiveHint).toBe(true)
    expect(tools.find(tool => tool.name === 'add_note')?.annotations?.destructiveHint).toBe(false)
  })

  it('is told to name notes by title and date, never to show codes, and to list everything', async () => {
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('by their title and date')
    expect(instructions).toMatch(/NEVER show the user a ref code/)
    expect(instructions).toContain('rename_note')
    expect(instructions).toMatch(/list every open task/)
    const loops = (await client.listTools()).tools.find(tool => tool.name === 'open_loops')
    expect(loops?.description).toMatch(/NO project/)
  })

  it('cannot delete notes: that stays with the person in the app', async () => {
    const names = (await client.listTools()).tools.map(tool => tool.name)
    expect(names.filter(name => /delete|remove|forget/.test(name))).toEqual([])
  })
})

describe('dates people can read', () => {
  it('says today, yesterday, then weekday and date, and adds the year only when it is not this year', () => {
    expect(friendlyDay('2026-11-01', '2026-11-01')).toBe('today')
    expect(friendlyDay('2026-10-31', '2026-11-01')).toBe('yesterday')
    expect(friendlyDay('2026-10-30', '2026-11-01')).toBe('Fri 30 Oct')
    expect(friendlyDay('2026-11-04', '2026-11-01')).toBe('Wed 4 Nov')
    expect(friendlyDay('2025-12-31', '2026-01-01')).toBe('yesterday')
    expect(friendlyDay('2025-06-15', '2026-11-01')).toBe('Sun 15 Jun 2025')
    expect(fullDay('2026-11-01')).toBe('Sun 1 Nov 2026')
  })
})
