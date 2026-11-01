import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import { OwnerOAuthProvider } from '../src/oauth.ts'
import { Browser, CLIENT_ID, CLIENT_SECRET, FakeGoogle, signIn, type Identity } from './fake-google.ts'
import { INGEST, freePort, run, tempDir, testConfig, upload, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const BOB: Identity = { sub: '1002', email: 'bob@example.com', name: 'Bob' }
const REDIRECT = 'https://chatgpt.test/connector/callback'
const MCP_TOKEN = 'static-mcp-token-0123456789'
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/
const json = { 'Content-Type': 'application/json' }

let google: FakeGoogle
beforeAll(async () => { google = await FakeGoogle.start() })
afterAll(async () => { await google.close() })

let dir: Awaited<ReturnType<typeof tempDir>>
let server: Running | null = null
let origin = ''

async function boot(overrides: Partial<Config> = {}) {
  await server?.stop()
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = await run(testConfig(dir.dir, { port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, mcpToken: MCP_TOKEN, workerEnabled: false, ...overrides }), fetch, { googleEndpoints: google.endpoints })
}
beforeEach(async () => {
  dir = await tempDir()
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined)
  await boot()
})
afterEach(async () => { vi.restoreAllMocks(); await server?.stop(); server = null; await dir.clean() })

const rows = (file: string, sql: string) => { const db = new DatabaseSync(join(dir.dir, file)); const out = db.prepare(sql).all() as Array<Record<string, unknown>>; db.close(); return out }
const signedIn = async (who: Identity = ALICE) => { const browser = new Browser(); const response = await signIn(browser, origin, google, who); expect(response.status).toBe(302); return browser }

// ---------------------------------------------------------------- the assistant (MCP OAuth)

const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') } }
async function register(name = 'ChatGPT') {
  const response = await fetch(`${origin}/register`, { method: 'POST', headers: json, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })
  return ((await response.json()) as { client_id: string }).client_id
}
const authorizeUrl = (clientId: string, challenge: string) => `${origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp', resource: `${origin}/mcp` })}`
const requestIn = (html: string) => /name="request" value="([^"]+)"/.exec(html)?.[1] as string
const exchange = (body: Record<string, string>) => fetch(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })

/** ChatGPT's side of it: open /authorize in a browser that may or may not be signed in. */
async function consent(browser: Browser, clientName = 'ChatGPT') {
  const clientId = await register(clientName)
  const { verifier, challenge } = pkce()
  const first = await browser.fetch(authorizeUrl(clientId, challenge))
  return { clientId, verifier, first }
}

describe('the assistant sign-in (/authorize) goes through Google', () => {
  it('sends a signed-out person to Google, then asks them to approve, with no passphrase anywhere', async () => {
    const browser = new Browser()
    const { clientId, verifier, first } = await consent(browser, '<b>Evil</b> ChatGPT')
    expect(first.status).toBe(302)
    const toGoogleStart = first.headers.get('location') as string
    expect(toGoogleStart).toMatch(/^\/auth\/google\/start\?next=%2Fauthorize%2Fcontinue%3Frequest%3D/)

    const signedInResponse = await signIn(browser, origin, google, ALICE, { next: decodeURIComponent(toGoogleStart.split('next=')[1] as string) })
    expect(signedInResponse.status).toBe(302)
    const page = await browser.fetch(`${origin}${signedInResponse.headers.get('location')}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-store')
    const html = await page.text()
    expect(html).not.toMatch(/passphrase/i)
    expect(html).toContain('Signed in as <strong>alice@example.com</strong>')
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; ChatGPT')

    const approved = await browser.form(`${origin}/authorize/decision`, { request: requestIn(html), decision: 'approve' }, { Origin: origin })
    expect(approved.status).toBe(302)
    const back = new URL(approved.headers.get('location') as string)
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('xyz')
    const tokens = (await (await exchange({ grant_type: 'authorization_code', code: back.searchParams.get('code') as string, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT })).json()) as { access_token: string; refresh_token: string }

    // the token opens the assistant endpoint...
    const mcp = new Client({ name: 'test', version: '1' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }))
    expect((await mcp.listTools()).tools.length).toBeGreaterThan(5)
    await mcp.close()

    // ...and carries who approved it: in the stored rows, and in the auth info the MCP layer sees
    expect(rows('auth.sqlite', 'SELECT kind, user_id FROM oauth_tokens ORDER BY kind')).toEqual([{ kind: 'access', user_id: '1001' }, { kind: 'refresh', user_id: '1001' }])
    const reader = new OwnerOAuthProvider({ dbPath: join(dir.dir, 'auth.sqlite'), approver: { kind: 'passphrase', passphrase: 'unused-here' }, staticToken: MCP_TOKEN })
    try {
      expect((await reader.verifyAccessToken(tokens.access_token)).extra).toEqual({ userId: '1001' })
      expect((await reader.verifyAccessToken(MCP_TOKEN)).extra).toEqual({ userId: 'owner' })
    } finally { reader.close() }

    // a refreshed token is still that person's
    const refreshed = (await (await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).json()) as { access_token: string }
    expect(refreshed.access_token).toBeTruthy()
    expect(rows('auth.sqlite', "SELECT DISTINCT user_id FROM oauth_tokens")).toEqual([{ user_id: '1001' }])
  })

  it('goes straight to the approval page for someone already signed in, and still makes them approve', async () => {
    const browser = await signedIn()
    const { first } = await consent(browser)
    expect(first.status).toBe(200) // never silently approved: a link from a stranger must not hand out access
    expect(await first.text()).toContain('wants to read your voice notes')
    expect(rows('auth.sqlite', 'SELECT * FROM oauth_codes')).toEqual([])
  })

  it('does not issue a code to anyone who is not signed in, whatever they send', async () => {
    const owner = await signedIn()
    const { first } = await consent(owner)
    const request = requestIn(await first.text())
    const stranger = new Browser()
    const refused = await stranger.form(`${origin}/authorize/decision`, { request, decision: 'approve', passphrase: 'a long passphrase here' }, { Origin: origin })
    expect(refused.status).toBe(303)
    expect(refused.headers.get('location')).toMatch(/^\/auth\/google\/start/)
    expect(rows('auth.sqlite', 'SELECT * FROM oauth_codes')).toEqual([])
  })

  it('refuses an approval that another website submitted for a signed-in browser, and the request stays usable', async () => {
    const browser = await signedIn()
    const { first } = await consent(browser)
    const request = requestIn(await first.text())
    expect((await browser.form(`${origin}/authorize/decision`, { request, decision: 'approve' }, { Origin: 'https://evil.test' })).status).toBe(403)
    expect(rows('auth.sqlite', 'SELECT * FROM oauth_codes')).toEqual([])
    expect((await browser.form(`${origin}/authorize/decision`, { request, decision: 'approve' }, { Origin: origin })).status).toBe(302)
  })

  it('sends access_denied back when the person says no', async () => {
    const browser = await signedIn()
    const { first } = await consent(browser)
    const denied = await browser.form(`${origin}/authorize/decision`, { request: requestIn(await first.text()), decision: 'deny' }, { Origin: origin })
    expect(new URL(denied.headers.get('location') as string).searchParams.get('error')).toBe('access_denied')
  })

  it('never gets a person who is not on the list as far as the approval page', async () => {
    await boot({ allowedEmails: ['alice@example.com'] })
    const browser = new Browser()
    const { first } = await consent(browser)
    const toStart = decodeURIComponent((first.headers.get('location') as string).split('next=')[1] as string)
    const refused = await signIn(browser, origin, google, BOB, { next: toStart })
    expect(refused.status).toBe(403)
    expect((await browser.fetch(`${origin}${toStart}`)).status).toBe(302) // still signed out: sent back to Google
  })

  it('turns off tokens and devices the moment their person comes off ALLOWED_EMAILS', async () => {
    await boot({ allowedEmails: ['alice@example.com', 'bob@example.com'] })
    const browser = await signedIn(BOB)
    const { clientId, verifier, first } = await consent(browser)
    const approved = await browser.form(`${origin}/authorize/decision`, { request: requestIn(await first.text()), decision: 'approve' }, { Origin: origin })
    const code = new URL(approved.headers.get('location') as string).searchParams.get('code') as string
    const access = ((await (await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT })).json()) as { access_token: string }).access_token
    const phone = await pairDevice(browser)
    const call = (token: string) => fetch(`${origin}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: '{}' })
    expect((await call(access)).status).not.toBe(401)
    expect((await fetch(`${origin}/v1/ping`, { headers: { Authorization: `Bearer ${phone.token}` } })).status).toBe(200)

    await boot({ allowedEmails: ['alice@example.com'] }) // the owner removes Bob
    expect((await call(access)).status).toBe(401)
    expect((await fetch(`${origin}/v1/ping`, { headers: { Authorization: `Bearer ${phone.token}` } })).status).toBe(401)
    expect((await browser.fetch(`${origin}/pair`)).status).toBe(302) // and his browser session
  })

  it('still lets the static tokens in, as the owner identity', async () => {
    const mcp = new Client({ name: 'test', version: '1' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }))
    expect((await mcp.listTools()).tools.length).toBeGreaterThan(5)
    await mcp.close()
    expect((await upload(origin)).status).toBe(201)
    expect(await (await fetch(`${origin}/v1/me`, { headers: { Authorization: `Bearer ${INGEST}` } })).json()).toMatchObject({ device: null, userId: 'owner' })
  })

  it('ignores OWNER_PASSPHRASE while Google is on', async () => {
    await boot({ ownerPassphrase: 'a long passphrase here' })
    const browser = new Browser()
    const { first } = await consent(browser)
    expect(first.status).toBe(302) // to Google, not to a passphrase page
    const refused = await browser.form(`${origin}/authorize/decision`, { request: 'whatever', decision: 'approve', passphrase: 'a long passphrase here' }, { Origin: origin })
    expect(refused.status).toBe(400)
  })
})

// ---------------------------------------------------------------- adding a device

async function startPairing(name = 'Pixel') {
  return (await (await fetch(`${origin}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: name }) })).json()) as { pairId: string; pollToken: string; userCode: string }
}
const poll = async (s: { pairId: string; pollToken: string }) => (await (await fetch(`${origin}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: s.pairId, pollToken: s.pollToken }) })).json()) as { status: string; token?: string; deviceId?: string }
const decide = (browser: Browser, code: string, decision = 'approve', headers: Record<string, string> = { Origin: origin }) => browser.form(`${origin}/pair/decision`, { code, decision }, headers)
async function pairDevice(browser: Browser, name = 'Pixel') {
  const start = await startPairing(name)
  expect((await decide(browser, start.userCode)).status).toBe(200)
  const done = await poll(start)
  return { token: done.token as string, deviceId: done.deviceId as string }
}
const me = async (token: string) => (await (await fetch(`${origin}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { device: { name: string } | null; userId: string }

describe('connecting a device now needs a Google sign-in, not a passphrase', () => {
  it('sends a signed-out person to sign in and brings them back to the code', async () => {
    const start = await startPairing('My phone')
    const response = await new Browser().fetch(`${origin}/pair?code=${start.userCode}`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/auth/google/start?next=${encodeURIComponent(`/pair?code=${start.userCode}`)}`)
  })

  it('shows the request to a signed-in person, who approves it; the device carries their id', async () => {
    const browser = await signedIn()
    const start = await startPairing('My phone')
    const page = await browser.fetch(`${origin}/pair?code=${start.userCode}`)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('My phone')
    expect(html).toContain('Signed in as <strong>alice@example.com</strong>')
    expect(html).not.toMatch(/passphrase/i)
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")

    const approved = await decide(browser, start.userCode)
    expect(await approved.text()).toContain('Device connected')
    const done = await poll(start)
    expect(done).toMatchObject({ status: 'approved' })
    expect(await me(done.token as string)).toMatchObject({ device: { name: 'My phone' }, userId: '1001' })
    expect(rows('devices.sqlite', 'SELECT name, user_id FROM devices')).toEqual([{ name: 'My phone', user_id: '1001' }])
    const list = (await (await fetch(`${origin}/v1/devices`, { headers: { Authorization: `Bearer ${done.token}` } })).json()) as { devices: Array<{ userId: string }> }
    expect(list.devices[0]?.userId).toBe('1001')
  })

  it('approves nothing without a session, with a passphrase instead, or on a foreign site\'s say-so', async () => {
    await boot({ ownerPassphrase: 'a long passphrase here' })
    const owner = await signedIn()
    const start = await startPairing()
    const stranger = await new Browser().form(`${origin}/pair/decision`, { code: start.userCode, decision: 'approve', passphrase: 'a long passphrase here' }, { Origin: origin })
    expect(stranger.status).toBe(401)
    expect((await decide(owner, start.userCode, 'approve', { Origin: 'https://evil.test' })).status).toBe(403)
    expect(await poll(start)).toEqual({ status: 'pending' })
    expect((await decide(owner, start.userCode, 'deny')).status).toBe(200)
    expect(await poll(start)).toEqual({ status: 'denied' })
  })

  it('says so when the code is wrong or has expired', async () => {
    const browser = await signedIn()
    const response = await decide(browser, 'ABCD-EFGH')
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not valid')
  })
})

describe('adding a device from one that is already connected', () => {
  const offer = async (token: string) => fetch(`${origin}/v1/pair/offer`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  const claim = (code: string, deviceName = 'New tablet') => fetch(`${origin}/v1/pair/claim`, { method: 'POST', headers: json, body: JSON.stringify({ code, deviceName }) })
  const offered = async (token: string) => (await (await offer(token)).json()) as { offerId: string; userCode: string; expiresIn: number; endpoint: string }

  it('needs a connected device to make a code, and the new device gets a token for the same person', async () => {
    expect((await fetch(`${origin}/v1/pair/offer`, { method: 'POST' })).status).toBe(401)
    expect((await offer('vbd_nope')).status).toBe(401)
    const phone = await pairDevice(await signedIn())
    const code = await offered(phone.token)
    expect(code.userCode).toMatch(CODE)
    expect(code).toMatchObject({ expiresIn: 120, endpoint: origin })
    const status = async () => ((await (await fetch(`${origin}/v1/pair/offer/${code.offerId}`, { headers: { Authorization: `Bearer ${phone.token}` } })).json()) as { status: string }).status
    expect(await status()).toBe('pending')

    const response = await claim(code.userCode.toLowerCase().replace('-', ' '))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const tablet = (await response.json()) as { token: string; deviceId: string; endpoint: string }
    expect(tablet.endpoint).toBe(origin)
    expect(tablet.token).toMatch(/^vbd_/)
    expect(await me(tablet.token)).toMatchObject({ device: { name: 'New tablet' }, userId: '1001' })
    expect(await status()).toBe('claimed')
    expect((await upload(origin, { token: tablet.token })).status).toBe(201)
  })

  it('works once: the same code is refused the second time', async () => {
    const phone = await pairDevice(await signedIn())
    const code = await offered(phone.token)
    expect((await claim(code.userCode)).status).toBe(200)
    const again = await claim(code.userCode)
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: string }).error).toMatch(/not valid/)
  })

  it('throttles guessing by address: five wrong codes and even the right one is refused', async () => {
    const phone = await pairDevice(await signedIn())
    const code = await offered(phone.token)
    for (let n = 0; n < 5; n += 1) expect((await claim(`WRNG-${n}ABC`.replace(/[01ILO]/g, 'X'))).status).toBe(400)
    expect((await claim(code.userCode)).status).toBe(429)
    expect(rows('devices.sqlite', 'SELECT * FROM devices')).toHaveLength(1) // only the phone
  })

  it('lets the owner\'s upload token make a code too, for the owner identity, and caps how many are showing', async () => {
    const first = await offered(INGEST)
    expect((await claim(first.userCode)).status).toBe(200)
    expect(rows('devices.sqlite', 'SELECT user_id FROM devices')).toEqual([{ user_id: 'owner' }])
    for (let n = 0; n < 3; n += 1) expect((await offer(INGEST)).status).toBe(200)
    expect((await offer(INGEST)).status).toBe(429)
  })

  it('only tells the person who made a code whether it was used', async () => {
    const phone = await pairDevice(await signedIn())
    const code = await offered(phone.token)
    const asOwner = await fetch(`${origin}/v1/pair/offer/${code.offerId}`, { headers: { Authorization: `Bearer ${INGEST}` } }) // a different identity
    expect(((await asOwner.json()) as { status: string }).status).toBe('expired')
  })
})
