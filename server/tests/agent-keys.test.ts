import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentKeys, KEY_PREFIX } from '../src/agent-keys.ts'
import { Browser, CLIENT_ID, CLIENT_SECRET, FakeGoogle, signIn, type Identity } from './fake-google.ts'
import { freePort, run, tempDir, testConfig, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const BOB: Identity = { sub: '1002', email: 'bob@example.com', name: 'Bob' }

describe('the key store', () => {
  it('makes a key that works, keeps only its hash, and shows nothing else', () => {
    const keys = new AgentKeys(':memory:')
    const made = keys.create('u1', '  My laptop  ')
    expect(made?.secret).toMatch(new RegExp(`^${KEY_PREFIX}[A-Za-z0-9_-]{43}$`))
    expect(made?.key.name).toBe('My laptop')
    expect(keys.verify(made!.secret)).toEqual({ userId: 'u1', id: made!.key.id })
    expect(JSON.stringify(keys.list('u1'))).not.toContain(made!.secret)
    expect(keys.list('u2')).toEqual([])
  })

  it('stores a hash, not the key', async () => {
    const dir = await tempDir()
    try {
      const keys = new AgentKeys(join(dir.dir, 'k.sqlite'))
      const made = keys.create('u1', 'x')!
      keys.close()
      const db = new DatabaseSync(join(dir.dir, 'k.sqlite'))
      const rows = JSON.stringify(db.prepare('SELECT * FROM agent_keys').all())
      db.close()
      expect(rows).not.toContain(made.secret)
      expect(rows).not.toContain(made.secret.slice(KEY_PREFIX.length, KEY_PREFIX.length + 20))
    } finally { await dir.clean() }
  })

  it('rejects anything that is not a live key', () => {
    const keys = new AgentKeys(':memory:')
    const made = keys.create('u1', 'x')!
    for (const bad of ['', 'vbk_', 'vbk_nope', made.secret.slice(0, -1), made.secret + 'x', `x${made.secret}`, 'vbk_' + 'a'.repeat(500)]) expect(keys.verify(bad), bad.slice(0, 20)).toBeNull()
    expect(keys.revoke('u2', made.key.id)).toBe(false) // someone else's key
    expect(keys.verify(made.secret)).not.toBeNull()
    expect(keys.revoke('u1', made.key.id)).toBe(true)
    expect(keys.verify(made.secret)).toBeNull()
    expect(keys.revoke('u1', made.key.id)).toBe(false)
  })

  it('records when a key was last used, at most once a minute, and caps how many a person can hold', () => {
    let now = Date.parse('2026-11-02T10:00:00Z')
    const keys = new AgentKeys(':memory:', { now: () => now })
    const made = keys.create('u1', 'x')!
    expect(keys.list('u1')[0]?.lastUsedAt).toBeNull()
    keys.verify(made.secret)
    expect(keys.list('u1')[0]?.lastUsedAt).toBe('2026-11-02T10:00:00.000Z')
    now += 10_000; keys.verify(made.secret)
    expect(keys.list('u1')[0]?.lastUsedAt).toBe('2026-11-02T10:00:00.000Z')
    now += 120_000; keys.verify(made.secret)
    expect(keys.list('u1')[0]?.lastUsedAt).toBe('2026-11-02T10:02:10.000Z')
    for (let i = 1; i < 20; i += 1) expect(keys.create('u1', `k${i}`)).not.toBeNull()
    expect(keys.create('u1', 'one too many')).toBeNull()
    expect(keys.create('u2', 'someone else')).not.toBeNull()
  })
})

describe('keys through the running server', () => {
  let google: FakeGoogle
  let dir: Awaited<ReturnType<typeof tempDir>>
  let server: Running | null = null
  let origin = ''
  const clients: Client[] = []

  beforeAll(async () => { google = await FakeGoogle.start() })
  afterAll(async () => { await google.close() })
  beforeEach(async () => {
    for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined)
    dir = await tempDir()
    await boot(['alice@example.com', 'bob@example.com'])
  })
  afterEach(async () => { vi.restoreAllMocks(); for (const client of clients.splice(0)) await client.close().catch(() => undefined); await server?.stop(); server = null; await dir.clean() })

  async function boot(allowed: string[]) {
    await server?.stop()
    server = null
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    server = await run(testConfig(dir.dir, { port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, allowedEmails: allowed, workerEnabled: false }), fetch, { googleEndpoints: google.endpoints })
  }
  const signedIn = async (who: Identity) => { const browser = new Browser(); expect((await signIn(browser, origin, google, who)).status).toBe(302); return browser }
  const make = async (browser: Browser, name = 'Laptop') => {
    const response = await browser.form(`${origin}/account/keys`, { name }, { Origin: origin })
    expect(response.status).toBe(200)
    const html = await response.text()
    const secret = /vbk_[A-Za-z0-9_-]{43}/.exec(html)?.[0] ?? ''
    return { html, secret }
  }
  const connect = async (secret: string) => {
    const client = new Client({ name: 'agent', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }))
    clients.push(client)
    return client
  }
  const say = async (client: Client, name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>).map(part => part.text).join('\n')

  it('makes a key once, with ready-to-paste settings for each agent, and a coding agent can use it', async () => {
    const browser = await signedIn(ALICE)
    const { html, secret } = await make(browser)
    expect(secret).toMatch(/^vbk_/)
    expect(html).toContain('will not be shown again')
    expect(html).toContain(`claude mcp add --transport http voicebrain ${origin}/mcp --header &quot;Authorization: Bearer ${secret}&quot;`)
    expect(html).toContain('opencode.json')
    expect(html).toContain('&quot;oauth&quot;: false')
    expect(html).toContain('.cursor/mcp.json')
    expect(html).toContain('bearer_token_env_var')
    const listed = await (await browser.fetch(`${origin}/account`)).text()
    expect(listed).toContain('Laptop')
    expect(listed).not.toContain(secret) // never shown again

    const client = await connect(secret)
    expect((await client.listTools()).tools.length).toBeGreaterThanOrEqual(13)
    expect(await say(client, 'brief')).toContain('# Brief')
  })

  it('only needs a signed-in person, and refuses another site', async () => {
    expect((await new Browser().form(`${origin}/account/keys`, { name: 'x' }, { Origin: origin })).status).toBe(303)
    const browser = await signedIn(ALICE)
    expect((await browser.form(`${origin}/account/keys`, { name: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await browser.form(`${origin}/account/keys`, { name: 'x' }, { Origin: 'null' })).status).toBe(403)
    expect(await (await browser.fetch(`${origin}/account`)).text()).not.toContain('class="keys"')
  })

  it('stops working the moment it is revoked, and a stranger cannot revoke it', async () => {
    const alice = await signedIn(ALICE)
    const bob = await signedIn(BOB)
    const { secret } = await make(alice)
    const id = /name="id" value="([^"]+)"/.exec(await (await alice.fetch(`${origin}/account`)).text())?.[1] ?? ''
    expect(id).not.toBe('')
    expect(await (await bob.form(`${origin}/account/keys/revoke`, { id }, { Origin: origin })).text()).toContain('That key was not found')
    expect(await say(await connect(secret), 'brief')).toContain('# Brief')
    expect(await (await alice.form(`${origin}/account/keys/revoke`, { id }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect(await (await alice.form(`${origin}/account/keys/revoke`, { id }, { Origin: origin })).text()).toContain('Key revoked')
    const refused = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(refused.status).toBe(401)
  })

  it('gives each key only its owner’s notes', async () => {
    const alice = await connect((await make(await signedIn(ALICE))).secret)
    const bob = await connect((await make(await signedIn(BOB))).secret)
    await say(alice, 'add_note', { text: 'The zebracorn meeting is on Tuesday.' })
    expect(await say(alice, 'search', { query: 'zebracorn' })).toContain('zebracorn')
    const seenByBob = await say(bob, 'search', { query: 'zebracorn' })
    expect(seenByBob).toMatch(/No notes or wiki pages match/)
    expect(seenByBob).not.toContain('Tuesday') // nothing of Alice's note reaches Bob's key
  })

  it('stops working when the person is taken off the allowlist, and works again if they return', async () => {
    const { secret } = await make(await signedIn(ALICE))
    await boot(['bob@example.com'])
    const gone = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(gone.status).toBe(401)
    await boot(['alice@example.com', 'bob@example.com'])
    expect(await say(await connect(secret), 'brief')).toContain('# Brief')
  })

  it('does not accept an ordinary or made-up token as a key', async () => {
    for (const token of ['vbk_notarealkey', 'vbd_devicetoken', 'plain']) {
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
      expect(response.status, token).toBe(401)
    }
  })
})
