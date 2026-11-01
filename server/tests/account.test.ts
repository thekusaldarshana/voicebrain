import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser, CLIENT_ID, CLIENT_SECRET, FakeGoogle, connectDrive, signIn, type Identity } from './fake-google.ts'
import { freePort, run, tempDir, testConfig, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const json = { 'Content-Type': 'application/json' }

let google: FakeGoogle
let dir: Awaited<ReturnType<typeof tempDir>>
let server: Running
let origin = ''

beforeAll(async () => { google = await FakeGoogle.start() })
afterAll(async () => { await google.close() })
beforeEach(async () => {
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined)
  dir = await tempDir()
})
afterEach(async () => { vi.restoreAllMocks(); await server?.stop(); await dir.clean() })

async function boot(drive: boolean) {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = await run(testConfig(dir.dir, { port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, allowedEmails: [ALICE.email], driveEnabled: drive, tokenEncryptionKey: drive ? randomBytes(32).toString('base64') : '', workerEnabled: false }), fetch, { googleEndpoints: google.endpoints })
}
const signedIn = async () => { const browser = new Browser(); expect((await signIn(browser, origin, google, ALICE)).status).toBe(302); return browser }
const text = async (response: Response) => response.text()

describe('the account page', () => {
  it('sends a signed-out visitor to sign in, and brings them back afterwards', async () => {
    await boot(false)
    const response = await new Browser().fetch(`${origin}/account`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/auth/google/start?next=%2Faccount')
  })

  it('shows who is signed in, is not cached, and cannot be framed', async () => {
    await boot(false)
    const response = await (await signedIn()).fetch(`${origin}/account`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const html = await text(response)
    expect(html).toContain('alice@example.com')
    expect(html).not.toContain('Google Drive') // Drive is off on this server, so it is not offered
  })

  it('offers Drive until it is connected, then lets the person disconnect it', async () => {
    await boot(true)
    const browser = await signedIn()
    expect(await text(await browser.fetch(`${origin}/account`))).toContain('href="/auth/drive/start"')
    expect((await connectDrive(browser, origin, google, ALICE)).status).toBe(200)
    const connected = await text(await browser.fetch(`${origin}/account`))
    expect(connected).toContain('Disconnect Drive')
    expect(connected).not.toContain('href="/auth/drive/start"')
    const done = await browser.form(`${origin}/account/drive/disconnect`, {}, { Origin: origin })
    expect(done.status).toBe(200)
    expect(await text(done)).toContain('Google Drive is disconnected.')
    expect(await text(await browser.fetch(`${origin}/account`))).toContain('href="/auth/drive/start"')
  })

  it('lets a browser send its own origin on a form post, and refuses a null or foreign one', async () => {
    await boot(false)
    const browser = await signedIn()
    // With `Referrer-Policy: no-referrer` Chrome sends `Origin: null` on this site's own forms and the sign-out failed in real use.
    expect((await browser.fetch(`${origin}/account`)).headers.get('referrer-policy')).toBe('same-origin')
    expect((await browser.form(`${origin}/account/signout`, {}, { Origin: 'null' })).status).toBe(403)
    expect((await browser.form(`${origin}/account/signout`, {}, { Origin: origin })).status).toBe(200)
  })

  it('signs out this browser only when the request comes from this site', async () => {
    await boot(false)
    const browser = await signedIn()
    const foreign = await browser.form(`${origin}/account/signout`, {}, { Origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
    expect((await browser.fetch(`${origin}/account`)).status).toBe(200) // still signed in
    const done = await browser.form(`${origin}/account/signout`, {}, { Origin: origin })
    expect(done.status).toBe(200)
    expect(await text(done)).toContain('You are signed out')
    expect((await browser.fetch(`${origin}/account`)).status).toBe(302) // now asked to sign in again
  })

  it('refuses a Drive disconnect from another site', async () => {
    await boot(true)
    const browser = await signedIn()
    await connectDrive(browser, origin, google, ALICE)
    expect((await browser.form(`${origin}/account/drive/disconnect`, {}, { Origin: 'https://evil.example' })).status).toBe(403)
    expect(await text(await browser.fetch(`${origin}/account`))).toContain('Disconnect Drive')
  })
})

describe('/v1/me', () => {
  it('tells a paired device which account it belongs to', async () => {
    await boot(false)
    const browser = await signedIn()
    const start = (await (await fetch(`${origin}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: 'Phone' }) })).json()) as { pairId: string; pollToken: string; userCode: string }
    await browser.form(`${origin}/pair/decision`, { code: start.userCode, decision: 'approve' }, { Origin: origin })
    const { token } = (await (await fetch(`${origin}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }) })).json()) as { token: string }
    const me = (await (await fetch(`${origin}/v1/me`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { account: { email: string; name: string } | null }
    expect(me.account).toEqual({ email: 'alice@example.com', name: 'Alice' })
  })

  it('has no account for the owner identity (the static token)', async () => {
    await boot(false)
    const me = (await (await fetch(`${origin}/v1/me`, { headers: { Authorization: 'Bearer test-ingest-token-123' } })).json()) as { account: unknown }
    expect(me.account).toBeNull()
  })
})
