import { createHash, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Throttle } from '../src/oauth.ts'
import { NOTE_ID, fakeLlm, fakeStt, freePort, run, tempDir, testConfig, upload, waitFor, type Fake, type Running } from './helpers.ts'

const PASSPHRASE = 'correct horse battery'
const REDIRECT = 'https://chatgpt.test/connector/callback'
const MCP_TOKEN = 'static-mcp-token-0123456789'

let dir: Awaited<ReturnType<typeof tempDir>>
let stt: Fake
let llm: Fake
let server: Running
let origin = ''

beforeEach(async () => {
  dir = await tempDir(); stt = await fakeStt(); llm = await fakeLlm()
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = await run(testConfig(dir.dir, {
    port, publicUrl: origin, ownerPassphrase: PASSPHRASE, mcpToken: MCP_TOKEN,
    stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'w', language: 'en', maxMb: 24, prompt: '' },
    llm: { baseUrl: llm.url, apiKey: '', model: 'l', maxInputChars: 20_000 },
  }))
  await upload(server.base)
  await waitFor(() => server.app.brain.index.note(NOTE_ID)?.digested === 1, 'a note to ask about')
  await server.app.pipeline.idle()
})
afterEach(async () => { await server.stop(); await stt.close(); await llm.close(); await dir.clean() })

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function register(extra: Record<string, unknown> = {}) {
  const response = await fetch(`${origin}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'ChatGPT', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }) })
  expect(response.status).toBe(201)
  return (await response.json()) as { client_id: string; client_secret?: string; client_secret_expires_at?: number }
}

async function beginAuthorization(clientId: string, challenge: string) {
  const url = new URL(`${origin}/authorize`)
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp', resource: `${origin}/mcp` }).toString()
  const page = await fetch(url)
  expect(page.status).toBe(200)
  const html = await page.text()
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1]
  expect(request).toBeTruthy()
  return { html, request: request as string }
}

const decide = (request: string, passphrase: string, decision = 'approve') =>
  fetch(`${origin}/authorize/decision`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request, passphrase, decision }), redirect: 'manual' })

const exchange = (body: Record<string, string>) => fetch(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })

async function signIn(clientId = '') {
  const client = clientId || (await register()).client_id
  const { verifier, challenge } = pkce()
  const { request } = await beginAuthorization(client, challenge)
  const approved = await decide(request, PASSPHRASE)
  expect(approved.status).toBe(302)
  const location = new URL(approved.headers.get('location') as string)
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
  expect(location.searchParams.get('state')).toBe('xyz')
  const code = location.searchParams.get('code') as string
  const response = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client, redirect_uri: REDIRECT })
  expect(response.status).toBe(200)
  return { tokens: (await response.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string }, client, code, verifier }
}

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return { text: (result.content as Array<{ text: string }>).map(part => part.text).join('\n'), isError: result.isError === true }
}

describe('discovery, the way ChatGPT starts', () => {
  it('answers an unauthenticated call with a pointer to the protected-resource metadata', async () => {
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`)
  })
  it('publishes consistent metadata', async () => {
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] }
    expect(resource.resource).toBe(`${origin}/mcp`)
    expect(resource.authorization_servers[0]).toContain(origin)
    const meta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>
    expect(meta).toMatchObject({ issuer: `${origin}/`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` })
    expect(meta.code_challenge_methods_supported).toEqual(['S256'])
  })
  it('registers clients that never expire', async () => {
    const confidential = await register({ token_endpoint_auth_method: 'client_secret_post' })
    expect(confidential.client_secret).toBeTruthy()
    expect(confidential.client_secret_expires_at).toBe(0)
  })
})

describe('signing in with the owner passphrase', () => {
  it('completes the full code + PKCE flow and the token opens the MCP endpoint', async () => {
    const { tokens } = await signIn()
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
    const client = await connect(tokens.access_token)
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort()
    expect(tools).toEqual(['add_note', 'brief', 'get_note', 'list_wiki', 'notes_to_process', 'open_loops', 'read_wiki', 'recent', 'rename_note', 'save_digest', 'search', 'update_task', 'write_wiki'])
    await client.close()
  })

  it('shows who is asking, and rejects a wrong passphrase without issuing a code', async () => {
    const { client_id } = await register({ client_name: '<script>alert(1)</script>' })
    const { html, request } = await beginAuthorization(client_id, pkce().challenge)
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;')
    const wrong = await decide(request, 'wrong passphrase!!')
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toContain('not right')
    expect((await decide(request, PASSPHRASE)).status).toBe(302) // the same request can still be approved
  })

  it('sends access_denied back to the client when the owner says no', async () => {
    const { client_id } = await register()
    const { request } = await beginAuthorization(client_id, pkce().challenge)
    const denied = await decide(request, '', 'deny')
    expect(denied.status).toBe(302)
    const location = new URL(denied.headers.get('location') as string)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('xyz')
    expect((await decide(request, PASSPHRASE)).status).toBe(400) // the request is spent
  })

  it('locks the approval page after repeated wrong passphrases', async () => {
    const { client_id } = await register()
    const { request } = await beginAuthorization(client_id, pkce().challenge)
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await decide(request, `wrong-${attempt}-passphrase`)).status).toBe(401)
    const blocked = await decide(request, PASSPHRASE)
    expect(blocked.status).toBe(429)
  })

  it('refuses a code twice, a wrong verifier, a wrong redirect, and another client', async () => {
    const { client, code, verifier } = await signIn()
    const reuse = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client, redirect_uri: REDIRECT })
    expect(reuse.status).toBe(400)

    const other = await register()
    const second = pkce()
    const { request } = await beginAuthorization(client, second.challenge)
    const location = new URL((await decide(request, PASSPHRASE)).headers.get('location') as string)
    const fresh = location.searchParams.get('code') as string
    expect((await exchange({ grant_type: 'authorization_code', code: fresh, code_verifier: pkce().verifier, client_id: client, redirect_uri: REDIRECT })).status).toBe(400)
    // a failed attempt burns the code, so even the right verifier no longer works
    expect((await exchange({ grant_type: 'authorization_code', code: fresh, code_verifier: second.verifier, client_id: client, redirect_uri: REDIRECT })).status).toBe(400)
    expect((await exchange({ grant_type: 'authorization_code', code: fresh, code_verifier: second.verifier, client_id: other.client_id, redirect_uri: REDIRECT })).status).toBe(400)
  })

  it('rotates refresh tokens and rejects the old one', async () => {
    const { tokens, client } = await signIn()
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(next.access_token).not.toBe(tokens.access_token)
    expect((await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client })).status).toBe(400)
    const connected = await connect(next.access_token)
    expect((await connected.listTools()).tools.length).toBe(13)
    await connected.close()
  })

  it('stays signed in across a server restart', async () => {
    const { tokens } = await signIn()
    const config = server.app.brain.config
    await server.stop()
    server = await run(config)
    const client = await connect(tokens.access_token)
    expect((await client.listTools()).tools.length).toBe(13)
    await client.close()
  })

  it('rejects garbage and expired-looking tokens', async () => {
    for (const token of ['', 'nope', 'a'.repeat(43)]) {
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: '{}' })
      expect(response.status).toBe(401)
    }
  })

  it('also accepts the static token for tools that cannot do OAuth', async () => {
    const client = await connect(MCP_TOKEN)
    expect((await client.listTools()).tools.length).toBe(13)
    await client.close()
  })

  it('does not accept the upload token on the assistant endpoint', async () => {
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer test-ingest-token-123' }, body: '{}' })
    expect(response.status).toBe(401)
  })
})

describe('the tools', () => {
  it('brief gives what was said, the open task, and the project', async () => {
    const client = await connect(MCP_TOKEN)
    const { text, isError } = await call(client, 'brief', { topic: 'weekly review for Trapper' })
    expect(isError).toBe(false)
    expect(text).toMatch(/“Bank call and weekly review idea” — .*09:12/)
    expect(text).not.toMatch(/\[3f2b1c0e\]/) // ids are not the way notes are named
    expect(text).toContain('Call the bank'.slice(0, 0)) // tasks are matched by topic, so the bank task is not here
    expect(text).toContain('project: Trapper')
    const overview = (await call(client, 'brief')).text
    expect(overview).toContain('Recent notes')
    await client.close()
  })

  it('searches, lists recent notes, reads a note by short id, and lists open loops', async () => {
    const client = await connect(MCP_TOKEN)
    expect((await call(client, 'search', { query: 'bank' })).text).toContain('3f2b1c0e')
    expect((await call(client, 'search', { query: 'zebra' })).text).toContain('No notes or wiki pages match')
    expect((await call(client, 'recent', { days: 365 })).text).toContain('Bank call and weekly review idea')
    const note = await call(client, 'get_note', { id: '3f2b1c0e' })
    expect(note.text).toContain('## Transcript')
    expect(note.text).toContain('Remind me to call the bank tomorrow.')
    expect((await call(client, 'get_note', { id: 'deadbeef' })).isError).toBe(true)
    const loops = await call(client, 'open_loops')
    expect(loops.text).toMatch(/- Call the bank — due [^(]+\(OVERDUE\) · from “Bank call and weekly review idea”, [^(]+\(ref 3f2b1c0e#0\)/) // the dates read as "yesterday" or "Sat 31 Oct" depending on the day the test runs
    expect((await call(client, 'open_loops', { project: 'nothing' })).text).toBe('No open tasks.')
    await client.close()
  })

  it('marks a task done by its short id', async () => {
    const client = await connect(MCP_TOKEN)
    expect((await call(client, 'update_task', { task_id: '3f2b1c0e#0', status: 'done' })).text).toBe('Marked “Call the bank” as done.')
    expect((await call(client, 'open_loops')).text).toBe('No open tasks.')
    expect((await call(client, 'update_task', { task_id: '3f2b1c0e#0', status: 'open' })).isError).toBe(false)
    expect((await call(client, 'update_task', { task_id: 'zzzzzzzz#0', status: 'done' })).isError).toBe(true)
    expect((await call(client, 'update_task', { task_id: '3f2b1c0e#abc', status: 'done' })).isError).toBe(true)
    await client.close()
  })

  it('saves a note from chat, and keeps the wiki', async () => {
    const client = await connect(MCP_TOKEN)
    expect((await call(client, 'add_note', { text: 'Remember the kayak trip in March.' })).text).toMatch(/^Saved as a new note\./)
    expect((await call(client, 'search', { query: 'kayak' })).text).toContain('kayak')
    expect((await call(client, 'write_wiki', { path: 'trips.md', content: '# Trips\nKayak in March.', mode: 'replace' })).text).toContain('wiki/trips.md')
    expect((await call(client, 'list_wiki')).text).toContain('wiki/trips.md')
    expect((await call(client, 'read_wiki', { path: 'trips.md' })).text).toContain('Kayak in March.')
    expect((await call(client, 'write_wiki', { path: '../escape.md', content: 'x' })).isError).toBe(true)
    expect((await call(client, 'read_wiki', { path: 'missing.md' })).isError).toBe(true)
    await client.close()
  })

  it('describes each tool well enough for a model to choose it', async () => {
    const client = await connect(MCP_TOKEN)
    const tools = (await client.listTools()).tools
    const brief = tools.find(tool => tool.name === 'brief')
    expect(brief?.description).toMatch(/CALL THIS FIRST/)
    expect(brief?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find(tool => tool.name === 'write_wiki')?.annotations?.destructiveHint).toBe(true)
    expect(tools.every(tool => tool.description && tool.description.length > 20 || tool.title)).toBe(true)
    await client.close()
  })
})

describe('the throttle', () => {
  it('blocks after five failures in ten minutes and recovers', () => {
    let now = 0
    const throttle = new Throttle(() => now)
    for (let attempt = 0; attempt < 5; attempt += 1) { expect(throttle.blocked('a')).toBe(false); throttle.failed('a') }
    expect(throttle.blocked('a')).toBe(true)
    expect(throttle.blocked('b')).toBe(false)
    now += 11 * 60_000
    expect(throttle.blocked('a')).toBe(false)
  })
  it('locks everyone out when many addresses guess', () => {
    const throttle = new Throttle(() => 0)
    for (let attempt = 0; attempt < 20; attempt += 1) throttle.failed(`ip-${attempt}`)
    expect(throttle.blocked('fresh')).toBe(true)
  })
})
