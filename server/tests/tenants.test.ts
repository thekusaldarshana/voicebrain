import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import { Browser, CLIENT_ID, CLIENT_SECRET, FakeGoogle, signIn, type Identity } from './fake-google.ts'
import { INGEST, NOTE_ID, fakeLlm, fakeStt, freePort, run, tempDir, testConfig, upload, waitFor, type Fake, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const BOB: Identity = { sub: '1002', email: 'bob@example.com', name: 'Bob' }
const BOBS_NOTE = '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d'
const REDIRECT = 'https://chatgpt.test/connector/callback'
const json = { 'Content-Type': 'application/json' }

let google: FakeGoogle
let stt: Fake
let llm: Fake
beforeAll(async () => { google = await FakeGoogle.start() })
afterAll(async () => { await google.close() })

let dir: Awaited<ReturnType<typeof tempDir>>
let server: Running | null = null
let origin = ''

async function boot(overrides: Partial<Config> = {}) {
  await server?.stop()
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = await run(testConfig(dir.dir, {
    port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, allowedEmails: ['alice@example.com', 'bob@example.com'],
    stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'w', language: 'en', maxMb: 24, prompt: '' },
    llm: { baseUrl: llm.url, apiKey: '', model: 'l', maxInputChars: 20_000 }, ...overrides,
  }), fetch, { googleEndpoints: google.endpoints })
}
beforeEach(async () => {
  dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm()
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined)
  await boot()
})
afterEach(async () => { vi.restoreAllMocks(); await server?.stop(); server = null; await stt.close(); await llm.close(); await dir.clean() })

interface Person { browser: Browser; device: string; mcp: string }

async function pairDevice(browser: Browser): Promise<string> {
  const start = (await (await fetch(`${origin}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: 'Phone' }) })).json()) as { pairId: string; pollToken: string; userCode: string }
  expect((await browser.form(`${origin}/pair/decision`, { code: start.userCode, decision: 'approve' }, { Origin: origin })).status).toBe(200)
  return ((await (await fetch(`${origin}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }) })).json()) as { token: string }).token
}

/** The assistant's side: ChatGPT sends this person through consent and ends up with an access token. */
async function assistantToken(browser: Browser): Promise<string> {
  const registered = (await (await fetch(`${origin}/register`, { method: 'POST', headers: json, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'ChatGPT', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const page = await browser.fetch(`${origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'x', scope: 'mcp', resource: `${origin}/mcp` })}`)
  const request = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] as string
  const approved = await browser.form(`${origin}/authorize/decision`, { request, decision: 'approve' }, { Origin: origin })
  const code = new URL(approved.headers.get('location') as string).searchParams.get('code') as string
  const tokens = (await (await fetch(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: registered.client_id, redirect_uri: REDIRECT }) })).json()) as { access_token: string }
  return tokens.access_token
}

async function person(who: Identity): Promise<Person> {
  const browser = new Browser()
  expect((await signIn(browser, origin, google, who)).status).toBe(302)
  return { browser, device: await pairDevice(browser), mcp: await assistantToken(browser) }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })
const status = async (token: string) => (await (await fetch(`${origin}/v1/status`, { headers: auth(token) })).json()) as { notes: number; waiting: number }
const digested = (token: string, notes: number) => waitFor(async () => { const s = await status(token); return s.notes === notes && s.waiting === 0 }, `${notes} digested note(s)`)

async function ask(token: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: auth(token) } }))
  try {
    const result = await client.callTool({ name, arguments: args })
    return { text: (result.content as Array<{ text: string }>).map(part => part.text).join('\n'), isError: result.isError === true }
  } finally { await client.close() }
}

describe('each person has their own notes, index and vault', () => {
  let alice: Person
  let bob: Person
  beforeEach(async () => {
    alice = await person(ALICE)
    bob = await person(BOB)
    expect((await upload(origin, { token: alice.device })).status).toBe(201)
    await digested(alice.device, 1)
  })

  it('keeps notes under users/<id>/, and the owner identity\'s paths where they always were', async () => {
    const mine = join(dir.dir, 'users', '1001')
    for (const path of [join('inbox', NOTE_ID, 'meta.json'), 'index.sqlite', 'vault']) expect(existsSync(join(mine, path)), path).toBe(true)
    expect(existsSync(join(dir.dir, 'inbox', NOTE_ID))).toBe(false) // nothing was filed under the owner
    expect((await upload(origin, { token: INGEST, id: BOBS_NOTE })).status).toBe(201) // the owner's upload token
    await waitFor(() => server?.app.brain.index.note(BOBS_NOTE)?.digested === 1, 'the owner note')
    expect(existsSync(join(dir.dir, 'inbox', BOBS_NOTE, 'meta.json'))).toBe(true)
    expect(existsSync(join(dir.dir, 'vault'))).toBe(true)
    expect((await status(alice.device)).notes).toBe(1) // and the owner's note is not Alice's
  })

  it('shows another person nothing: their status, and what they can search, read and list', async () => {
    expect(await status(bob.device)).toMatchObject({ notes: 0 })
    expect((await ask(bob.mcp, 'search', { query: 'bank' })).text).toBe('No notes or wiki pages match "bank".')
    expect((await ask(bob.mcp, 'recent', { days: 30 })).text).not.toContain(NOTE_ID.slice(0, 8))
    expect((await ask(bob.mcp, 'open_loops')).text).toBe('No open tasks.')
    expect((await ask(alice.mcp, 'open_loops')).text).toContain('Call the bank')
    expect((await ask(alice.mcp, 'search', { query: 'bank' })).text).toContain(NOTE_ID.slice(0, 8))
  })

  it('does not let another person read, rename, tick off or find a note by its id, ref, title or task', async () => {
    const aliceRecent = (await ask(alice.mcp, 'recent', { days: 30 })).text
    expect(aliceRecent).toContain(NOTE_ID.slice(0, 8))
    const title = /“([^”]+)”/.exec(aliceRecent)?.[1] as string
    const task = /ref ([0-9a-f]{8}#\d+)/.exec((await ask(alice.mcp, 'open_loops')).text)?.[1] as string
    for (const note of [NOTE_ID, NOTE_ID.slice(0, 8), title, 'bank']) {
      const read = await ask(bob.mcp, 'get_note', { note })
      expect(read.isError, note).toBe(true)
      expect(read.text).not.toMatch(/Remind me to call the bank/)
    }
    expect((await ask(bob.mcp, 'rename_note', { note: NOTE_ID, title: 'Hijacked' })).isError).toBe(true)
    for (const wanted of [task, 'call the bank']) expect((await ask(bob.mcp, 'update_task', { task: wanted, status: 'done' })).isError, wanted).toBe(true)
    expect((await ask(alice.mcp, 'open_loops')).text).toContain('Call the bank') // still open
    expect((await ask(alice.mcp, 'get_note', { note: NOTE_ID })).text).toContain('Remind me to call the bank')
    expect((await ask(alice.mcp, 'recent', { days: 30 })).text).not.toContain('Hijacked')
  })

  it('keeps the wiki apart too: a page one person writes does not exist for the other', async () => {
    expect((await ask(alice.mcp, 'write_wiki', { path: 'projects/secret.md', content: '# Secret\nonly for Alice', mode: 'replace' })).isError).toBe(false)
    expect((await ask(alice.mcp, 'read_wiki', { path: 'projects/secret.md' })).text).toContain('only for Alice')
    expect((await ask(bob.mcp, 'list_wiki')).text).not.toContain('secret')
    expect((await ask(bob.mcp, 'read_wiki', { path: 'projects/secret.md' })).isError).toBe(true)
    expect((await ask(bob.mcp, 'search', { query: 'Alice' })).text).not.toContain('secret')
    expect(existsSync(join(dir.dir, 'users', '1002', 'vault', 'wiki', 'projects', 'secret.md'))).toBe(false)
  })

  it('does not let another person edit, delete or retry a note over the app\'s API', async () => {
    const as = auth(bob.device)
    expect((await fetch(`${origin}/v1/notes/${NOTE_ID}`, { method: 'PATCH', headers: { ...as, ...json }, body: JSON.stringify({ title: 'Hijacked', tags: ['x'] }) })).status).toBe(404)
    expect((await fetch(`${origin}/v1/notes/${NOTE_ID}`, { method: 'DELETE', headers: as })).status).toBe(404)
    expect((await fetch(`${origin}/v1/notes/${NOTE_ID}/retry`, { method: 'POST', headers: as })).status).toBe(404)
    expect(await status(alice.device)).toMatchObject({ notes: 1 })
    expect(existsSync(join(dir.dir, 'users', '1001', 'inbox', NOTE_ID, 'meta.json'))).toBe(true)
    expect((await ask(alice.mcp, 'recent', { days: 30 })).text).not.toContain('Hijacked')
  })

  it('treats the same note id from two people as two notes, not a duplicate of one', async () => {
    expect((await upload(origin, { token: bob.device })).status).toBe(201) // Alice already has NOTE_ID
    await digested(bob.device, 1)
    expect((await fetch(`${origin}/v1/notes/${NOTE_ID}`, { method: 'DELETE', headers: auth(bob.device) })).status).toBe(204)
    expect(await status(bob.device)).toMatchObject({ notes: 0 })
    expect(await status(alice.device)).toMatchObject({ notes: 1 }) // Bob deleting his did nothing to hers
  })

  it('does not let a person walk out of their folder with a hostile note or wiki path', async () => {
    for (const path of ['../1001/vault/wiki/x.md', '../../users/1001/index.sqlite', '/etc/passwd']) {
      expect((await ask(bob.mcp, 'read_wiki', { path })).isError, path).toBe(true)
      expect((await ask(bob.mcp, 'write_wiki', { path, content: 'x', mode: 'replace' })).isError, path).toBe(true)
    }
    for (const id of ['../1001/inbox/' + NOTE_ID, '..%2F1001']) expect((await fetch(`${origin}/v1/notes/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth(bob.device) })).status).toBeGreaterThanOrEqual(400)
    expect(existsSync(join(dir.dir, 'users', '1001', 'inbox', NOTE_ID, 'meta.json'))).toBe(true)
  })

  describe('and taking someone off the allowlist', () => {
    beforeEach(async () => {
      expect((await upload(origin, { token: bob.device, id: BOBS_NOTE })).status).toBe(201)
      await digested(bob.device, 1)
    })

    it('cuts off their access at once but leaves their data, which comes back when they do', async () => {
      await boot({ allowedEmails: ['alice@example.com'] }) // the owner removes Bob and restarts
      expect((await fetch(`${origin}/v1/status`, { headers: auth(bob.device) })).status).toBe(401)
      expect((await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream', ...auth(bob.mcp) }, body: '{}' })).status).toBe(401)
      expect((await bob.browser.fetch(`${origin}/pair`)).status).toBe(302) // not signed in any more
      expect((await signIn(new Browser(), origin, google, BOB)).status).toBe(403)
      expect(existsSync(join(dir.dir, 'users', '1002', 'inbox', BOBS_NOTE, 'meta.json'))).toBe(true) // the data is still there
      expect(existsSync(join(dir.dir, 'users', '1002', 'index.sqlite'))).toBe(true)
      expect(await status(alice.device)).toMatchObject({ notes: 1 }) // and Alice is untouched

      await boot({ allowedEmails: ['alice@example.com', 'bob@example.com'] }) // allowed again
      expect(await status(bob.device)).toMatchObject({ notes: 1 })
      expect((await ask(bob.mcp, 'search', { query: 'bank' })).text).toContain(BOBS_NOTE.slice(0, 8))
    })

    it('does the same without a restart: the next request after the change is refused', async () => {
      const kept = await status(bob.device)
      expect(kept.notes).toBe(1)
      await boot({ allowedEmails: ['alice@example.com'] })
      expect((await fetch(`${origin}/v1/notes/${BOBS_NOTE}`, { method: 'DELETE', headers: auth(bob.device) })).status).toBe(401)
      expect(existsSync(join(dir.dir, 'users', '1002', 'inbox', BOBS_NOTE, 'meta.json'))).toBe(true)
    })
  })
})
