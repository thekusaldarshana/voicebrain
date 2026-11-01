import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { DriveAccounts, TokenCipher } from '../src/drive.ts'
import { DriveNotConnected } from '../src/drive-tokens.ts'
import { Browser, CLIENT_ID, CLIENT_SECRET, DRIVE_SCOPE, FakeGoogle, connectDrive, finishDrive, signIn, startDrive, type DriveConsent, type Identity } from './fake-google.ts'
import { freePort, run, tempDir, testConfig, INGEST, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const BOB: Identity = { sub: '1002', email: 'bob@example.com', name: 'Bob' }
const KEY = randomBytes(32).toString('base64')
const json = { 'Content-Type': 'application/json' }

let google: FakeGoogle
beforeAll(async () => { google = await FakeGoogle.start() })
afterAll(async () => { await google.close() })
beforeEach(() => {
  google.refreshDelay = 0; google.refreshOutage = false; google.refreshExpiresIn = 3599
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined)
})
afterEach(() => { vi.restoreAllMocks() })

describe('the stored token is sealed to its user', () => {
  const cipher = new TokenCipher(KEY)
  const secret = '1//0g-a-refresh-token-from-google'

  it('opens for the user it was sealed for, with a fresh nonce every time, and shows nothing of the token', () => {
    const one = cipher.seal(secret, '1001')
    expect(cipher.open(one, '1001')).toBe(secret)
    expect(cipher.seal(secret, '1001')).not.toBe(one)
    expect(one).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(one).not.toContain(secret)
    expect(one).not.toContain(Buffer.from(secret).toString('base64url'))
  })

  it('refuses a token moved to another user, another key, or changed anywhere', () => {
    const sealed = cipher.seal(secret, '1001')
    expect(() => cipher.open(sealed, '1002')).toThrow()
    expect(() => new TokenCipher(randomBytes(32).toString('base64')).open(sealed, '1001')).toThrow()
    const parts = sealed.split('.')
    for (const at of [1, 2, 3]) {
      const changed = [...parts]
      const raw = Buffer.from(changed[at] as string, 'base64url')
      raw[0] = (raw[0] ?? 0) ^ 1
      changed[at] = raw.toString('base64url')
      expect(() => cipher.open(changed.join('.'), '1001'), `part ${at}`).toThrow()
    }
    for (const junk of ['', 'v1', 'v2.a.b.c', `${sealed}.extra`, 'v1...', sealed.slice(0, -4)]) expect(() => cipher.open(junk, '1001'), junk).toThrow()
  })

  it('needs a key of exactly 32 bytes', () => {
    expect(() => new TokenCipher(randomBytes(16).toString('base64'))).toThrow()
  })
})

describe('the provider (with a clock it controls)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>
  let now = Date.parse('2026-11-01T10:00:00Z')
  let active = true
  let drive: DriveAccounts
  const make = (path = ':memory:', endpoints = google.endpoints) => new DriveAccounts({ path, cipher: new TokenCipher(KEY), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, endpoints, isActive: () => active, now: () => now })
  const connected = (who = ALICE, expiresIn = 3600) => { const grant = google.mintGrant(who); drive.save(who.sub, { ...grant, expiresIn }); return grant }

  beforeEach(async () => { dir = await tempDir(); now = Date.parse('2026-11-01T10:00:00Z'); active = true; google.refreshCalls = 0; drive = make(join(dir.dir, 'drive.sqlite')) })
  afterEach(async () => { drive.close(); await dir.clean() })

  it('hands out the access token it holds, and renews it a minute before it runs out', async () => {
    const grant = connected()
    expect(await drive.accessToken('1001')).toBe(grant.accessToken)
    now += 58 * 60_000
    expect(await drive.accessToken('1001')).toBe(grant.accessToken)
    expect(google.refreshCalls).toBe(0)
    now += 90_000 // inside the last minute
    const renewed = await drive.accessToken('1001')
    expect(renewed).not.toBe(grant.accessToken)
    expect(google.refreshCalls).toBe(1)
    expect(await drive.accessToken('1001')).toBe(renewed)
    expect(google.refreshCalls).toBe(1)
  })

  it('shares one renewal between everyone who asks while it is under way', async () => {
    connected()
    now += 2 * 3600_000
    google.refreshDelay = 80
    const answers = await Promise.all(Array.from({ length: 12 }, () => drive.accessToken('1001')))
    expect(new Set(answers).size).toBe(1)
    expect(google.refreshCalls).toBe(1)
    now += 2 * 3600_000
    await Promise.all([drive.accessToken('1001'), drive.accessToken('1001')])
    expect(google.refreshCalls).toBe(2) // a later expiry is a new renewal
  })

  it('keeps people apart: one person\'s renewal never answers for another', async () => {
    const [a, b] = [connected(ALICE), connected(BOB)]
    now += 2 * 3600_000
    google.refreshDelay = 40
    const [fromA, fromB] = await Promise.all([drive.accessToken('1001'), drive.accessToken('1002')])
    expect(fromA).not.toBe(fromB)
    expect(google.refreshCalls).toBe(2)
    expect([fromA, fromB]).not.toContain(a.accessToken)
    expect([fromA, fromB]).not.toContain(b.accessToken)
    await expect(drive.accessToken('1003')).rejects.toBeInstanceOf(DriveNotConnected)
  })

  it('says "not connected" when Google reports the grant revoked, and forgets the token', async () => {
    connected()
    google.revokeAccount('1001')
    now += 2 * 3600_000
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected)
    expect(drive.isConnected('1001')).toBe(false)
    const before = google.refreshCalls
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected)
    expect(google.refreshCalls).toBe(before) // it does not keep asking Google about a token it no longer holds
  })

  it('tells everyone waiting on a failed renewal, not just the first', async () => {
    connected()
    google.revokeAccount('1001')
    now += 2 * 3600_000
    google.refreshDelay = 40
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => drive.accessToken('1001')))
    expect(results.every(result => result.status === 'rejected' && result.reason instanceof DriveNotConnected)).toBe(true)
    expect(google.refreshCalls).toBe(1)
  })

  it('does not mistake a Google outage for a revoked grant: the token stays and works again later', async () => {
    connected()
    now += 2 * 3600_000
    google.refreshOutage = true
    const failure = await drive.accessToken('1001').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(DriveNotConnected)
    expect(drive.isConnected('1001')).toBe(true)
    google.refreshOutage = false
    expect(await drive.accessToken('1001')).toMatch(/^fake-drive-access-/)
  })

  it('refuses when nothing is connected, without calling Google', async () => {
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected)
    expect(google.refreshCalls).toBe(0)
  })

  it('stops serving someone who is no longer allowed, but keeps their connection for when they are', async () => {
    connected()
    active = false
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected) // even with a token in memory
    expect(drive.isConnected('1001')).toBe(true)
    active = true
    expect(await drive.accessToken('1001')).toMatch(/^fake-drive-access-/)
  })

  it('refuses a stored token that was changed or moved to another user, and does not delete it', async () => {
    connected()
    drive.close()
    const raw = new DatabaseSync(join(dir.dir, 'drive.sqlite'))
    const { sealed } = raw.prepare("SELECT sealed FROM drive_tokens WHERE user_id = '1001'").get() as { sealed: string }
    const body = (sealed.split('.')[2] as string)
    const flipped = sealed.replace(`.${body}.`, `.${(body[0] === 'A' ? 'B' : 'A') + body.slice(1)}.`)
    raw.prepare("INSERT INTO drive_tokens(user_id, sealed, connected_at) VALUES ('1002', ?, 'x')").run(sealed) // Alice's, filed under Bob
    raw.prepare("UPDATE drive_tokens SET sealed = ? WHERE user_id = '1001'").run(flipped) // and hers altered
    raw.close()
    drive = make(join(dir.dir, 'drive.sqlite'))
    google.refreshCalls = 0
    await expect(drive.accessToken('1002')).rejects.toBeInstanceOf(DriveNotConnected)
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected)
    expect(google.refreshCalls).toBe(0) // nothing was sent to Google on the strength of a token that did not verify
    expect(drive.isConnected('1001') && drive.isConnected('1002')).toBe(true)
  })

  it('does not decrypt with the wrong server key, and does not delete what it cannot read', async () => {
    connected()
    drive.close()
    drive = new DriveAccounts({ path: join(dir.dir, 'drive.sqlite'), cipher: new TokenCipher(randomBytes(32).toString('base64')), clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, endpoints: google.endpoints, now: () => now })
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected) // it has no access token in memory after a restart
    expect(drive.isConnected('1001')).toBe(true)
  })

  it('does not let a renewal that was in flight when the person disconnected bring the connection back', async () => {
    connected()
    now += 2 * 3600_000
    google.refreshDelay = 80
    const pending = drive.accessToken('1001')
    await new Promise(done => setTimeout(done, 20))
    expect(await drive.disconnect('1001')).toBe(true)
    await pending.catch(() => undefined)
    expect(drive.isConnected('1001')).toBe(false)
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected)
  })

  it('disconnects: Google is told to revoke, the token is gone, and a dead Google changes nothing', async () => {
    const grant = connected()
    expect(await drive.disconnect('1001')).toBe(true)
    expect(google.revokeCalls).toBeGreaterThan(0)
    expect(google.issuedRefreshTokens()).toContain(grant.refreshToken)
    await expect(drive.accessToken('1001')).rejects.toBeInstanceOf(DriveNotConnected)
    expect(await drive.disconnect('1001')).toBe(false) // nothing left
    drive.close()
    drive = make(join(dir.dir, 'drive.sqlite'), { ...google.endpoints, revoke: 'http://127.0.0.1:1/revoke' })
    connected()
    expect(await drive.disconnect('1001')).toBe(true) // Google could not be reached; this server still lets go
    expect(drive.isConnected('1001')).toBe(false)
  })
})

describe('connecting Drive in the browser', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>
  let server: Running | null = null
  let origin = ''

  async function boot(overrides: Partial<Config> = {}) {
    await server?.stop()
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    server = await run(testConfig(dir.dir, { port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, allowedEmails: ['alice@example.com', 'bob@example.com'], driveEnabled: true, tokenEncryptionKey: KEY, workerEnabled: false, ...overrides }), fetch, { googleEndpoints: google.endpoints })
  }
  beforeEach(async () => { dir = await tempDir(); google.revokeCalls = 0; await boot() })
  afterEach(async () => { await server?.stop(); server = null; await dir.clean() })

  const signedIn = async (who: Identity = ALICE) => { const browser = new Browser(); expect((await signIn(browser, origin, google, who)).status).toBe(302); return browser }
  const deviceFor = async (browser: Browser) => {
    const start = (await (await fetch(`${origin}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: 'Phone' }) })).json()) as { pairId: string; pollToken: string; userCode: string }
    await browser.form(`${origin}/pair/decision`, { code: start.userCode, decision: 'approve' }, { Origin: origin })
    return ((await (await fetch(`${origin}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }) })).json()) as { token: string }).token
  }
  const drive = async (token: string) => (await (await fetch(`${origin}/v1/drive`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { enabled: boolean; connected: boolean; canConnect: boolean; connectPath: string | null }
  const stored = () => { const db = new DatabaseSync(join(dir.dir, 'drive.sqlite')); const rows = db.prepare('SELECT user_id, sealed FROM drive_tokens').all() as Array<{ user_id: string; sealed: string }>; db.close(); return rows }
  const reachable = (id: string) => (server?.app.drive as DriveAccounts).accessToken(id)

  it('needs a signed-in person, and sends everyone else to sign in first', async () => {
    const response = await new Browser().fetch(`${origin}/auth/drive/start`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/auth/google/start?next=${encodeURIComponent('/auth/drive/start')}`)
    expect((await new Browser().fetch(`${origin}/auth/drive/callback?code=x&state=y`)).status).toBe(401)
  })

  it('asks Google for the Drive scope and nothing else, offline, with a fresh consent, PKCE, state and nonce', async () => {
    const browser = await signedIn()
    const response = await startDrive(browser, origin)
    expect(response.status).toBe(302)
    const url = new URL(response.headers.get('location') as string)
    expect(`${url.origin}${url.pathname}`).toBe(`${google.url}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID, response_type: 'code', scope: DRIVE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      code_challenge_method: 'S256', redirect_uri: `${origin}/auth/drive/callback`, login_hint: 'alice@example.com',
    })
    for (const name of ['state', 'nonce', 'code_challenge']) expect((url.searchParams.get(name) ?? '').length).toBeGreaterThan(20)
    expect(url.href).not.toContain(CLIENT_SECRET)
    const cookie = response.headers.getSetCookie().find(line => line.startsWith('vb_drive=')) as string
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Path=\/auth\/drive/)
  })

  it('connects: the app sees "connected" (and no secret), and the token is stored sealed', async () => {
    const browser = await signedIn()
    const device = await deviceFor(browser)
    expect(await drive(device)).toEqual({ enabled: true, connected: false, canConnect: true, connectPath: '/auth/drive/start' })
    const done = await connectDrive(browser, origin, google, ALICE)
    expect(done.status).toBe(200)
    expect(await done.text()).toContain('Drive connected')
    expect(await drive(device)).toMatchObject({ connected: true })
    const everything = JSON.stringify(await (await fetch(`${origin}/v1/drive`, { headers: { Authorization: `Bearer ${device}` } })).json())
    expect(everything).not.toMatch(/fake-drive|token/i)
    const rows = stored()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.user_id).toBe('1001')
    for (const secret of google.issuedRefreshTokens()) expect(rows[0]?.sealed).not.toContain(secret)
    expect(await reachable('1001')).toMatch(/^fake-drive-access-/)
    expect(google.refreshCalls).toBe(0) // the access token from the consent itself is used first
  })

  it.each<[string, DriveConsent, number, RegExp]>([
    ['the person unticks the Drive box', { scope: 'openid email profile' }, 403, /not granted/],
    ['Google grants some other scope instead', { scope: 'openid email profile https://www.googleapis.com/auth/drive.readonly' }, 403, /not granted/],
    ['Google sends no refresh token', { noRefreshToken: true }, 502, /lasting/],
    ['another Google account consents', { account: BOB }, 403, /different Google account/],
  ])('refuses and stores nothing when %s', async (_name, consent, status, message) => {
    const browser = await signedIn()
    const response = await connectDrive(browser, origin, google, ALICE, consent)
    expect(response.status).toBe(status)
    expect(await response.text()).toMatch(message)
    expect(stored()).toEqual([])
    expect(await drive(await deviceFor(browser))).toMatchObject({ connected: false })
    await expect(reachable('1001')).rejects.toBeInstanceOf(DriveNotConnected)
  })

  it('hands back what it was refused, so a rejected grant does not linger at Google', async () => {
    const before = google.revokeCalls
    await connectDrive(await signedIn(), origin, google, ALICE, { scope: 'openid email profile' })
    expect(google.revokeCalls).toBeGreaterThan(before)
  })

  it('lets a second attempt succeed after a refusal', async () => {
    const browser = await signedIn()
    expect((await connectDrive(browser, origin, google, ALICE, { scope: 'openid email profile' })).status).toBe(403)
    expect((await connectDrive(browser, origin, google, ALICE)).status).toBe(200)
    expect(stored()).toHaveLength(1)
  })

  describe('only the browser and person that started it can finish it', () => {
    const begin = async (browser: Browser) => {
      const url = (await startDrive(browser, origin)).headers.get('location') as string
      return { url, state: new URL(url).searchParams.get('state') as string }
    }

    it('refuses a callback from a browser that has no cookie for it, and never asks Google', async () => {
      const victim = await signedIn()
      const attacker = await signedIn(BOB)
      const { url } = await begin(attacker)
      const before = google.tokenCalls
      const response = await finishDrive(victim, google, BOB, url)
      expect(response.status).toBe(400)
      expect(google.tokenCalls).toBe(before)
      expect(stored()).toEqual([])
    })

    it('refuses someone else\'s state even when the browser has a Drive cookie of its own', async () => {
      const victim = await signedIn()
      await begin(victim) // the victim has started one
      const attacker = await signedIn(BOB)
      const { url } = await begin(attacker)
      expect((await finishDrive(victim, google, BOB, url)).status).toBe(400)
      expect(stored()).toEqual([])
    })

    it('refuses a state started by another signed-in person, even when the cookie was copied across', async () => {
      const alice = await signedIn()
      const bob = await signedIn(BOB)
      const { url, state } = await begin(alice)
      const code = google.issueDrive({ nonce: 'n', challenge: new URL(url).searchParams.get('code_challenge') as string, redirectUri: `${origin}/auth/drive/callback` }, ALICE)
      const session = bob.cookie('vb_session') as string
      const response = await fetch(`${origin}/auth/drive/callback?${new URLSearchParams({ code, state })}`, { headers: { cookie: `vb_session=${session}; vb_drive=${state}` }, redirect: 'manual' })
      expect(response.status).toBe(400) // Bob's session cannot complete Alice's consent
      expect(stored()).toEqual([])
    })

    it('works once: replaying the callback does nothing', async () => {
      const browser = await signedIn()
      const { url } = await begin(browser)
      const first = await finishDrive(browser, google, ALICE, url)
      expect(first.status).toBe(200)
      const replay = new URL(url)
      const code = google.issueDrive({ nonce: 'n', challenge: replay.searchParams.get('code_challenge') as string, redirectUri: `${origin}/auth/drive/callback` }, ALICE)
      const again = await browser.fetch(`${origin}/auth/drive/callback?${new URLSearchParams({ code, state: replay.searchParams.get('state') as string })}`)
      expect(again.status).toBe(400)
    })

    it('does not mix up a sign-in with a Drive connection, in either direction', async () => {
      const browser = await signedIn()
      const { state: driveState } = await begin(browser)
      const asSignIn = await fetch(`${origin}/auth/google/callback?${new URLSearchParams({ code: 'x', state: driveState })}`, { headers: { cookie: `vb_login=${driveState}` }, redirect: 'manual' })
      expect(asSignIn.status).toBe(400)
      const signInStart = await new Browser().fetch(`${origin}/auth/google/start`)
      const signInState = new URL(signInStart.headers.get('location') as string).searchParams.get('state') as string
      const asDrive = await fetch(`${origin}/auth/drive/callback?${new URLSearchParams({ code: 'x', state: signInState })}`, { headers: { cookie: `vb_session=${browser.cookie('vb_session')}; vb_drive=${signInState}` }, redirect: 'manual' })
      expect(asDrive.status).toBe(400)
      expect(stored()).toEqual([])
    })

    it('says so when the person cancels on Google\'s screen', async () => {
      const browser = await signedIn()
      const { state } = await begin(browser)
      const response = await browser.fetch(`${origin}/auth/drive/callback?${new URLSearchParams({ error: 'access_denied', state })}`)
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('cancelled')
    })
  })

  describe('and the app\'s endpoints', () => {
    it('answer only to a connected device or the upload token', async () => {
      expect((await fetch(`${origin}/v1/drive`)).status).toBe(401)
      expect((await fetch(`${origin}/v1/drive/disconnect`, { method: 'POST' })).status).toBe(401)
      expect(await drive(INGEST)).toMatchObject({ enabled: true, connected: false, canConnect: false }) // the owner identity is not a Google user
    })

    it('disconnect: revokes at Google, deletes the token, and says so', async () => {
      const browser = await signedIn()
      const device = await deviceFor(browser)
      await connectDrive(browser, origin, google, ALICE)
      const refresh = google.issuedRefreshTokens().at(-1) as string
      const response = await fetch(`${origin}/v1/drive/disconnect`, { method: 'POST', headers: { Authorization: `Bearer ${device}` } })
      expect(await response.json()).toEqual({ ok: true, connected: false })
      expect(google.revokeCalls).toBe(1)
      expect(stored()).toEqual([])
      expect(await drive(device)).toMatchObject({ connected: false })
      await expect(reachable('1001')).rejects.toBeInstanceOf(DriveNotConnected)
      const again = await fetch(`${origin}/v1/pair/offer`, { method: 'POST', headers: { Authorization: `Bearer ${device}` } }) // the device itself still works
      expect(again.status).toBe(200)
      expect(refresh).toBeTruthy()
    })

    it('are per person: Bob neither sees nor ends Alice\'s connection, and cannot get her token', async () => {
      const alice = await signedIn()
      const bob = await signedIn(BOB)
      const [aliceDevice, bobDevice] = [await deviceFor(alice), await deviceFor(bob)]
      await connectDrive(alice, origin, google, ALICE)
      expect(await drive(bobDevice)).toMatchObject({ connected: false })
      await fetch(`${origin}/v1/drive/disconnect`, { method: 'POST', headers: { Authorization: `Bearer ${bobDevice}` } })
      expect(await drive(aliceDevice)).toMatchObject({ connected: true })
      await expect(reachable('1002')).rejects.toBeInstanceOf(DriveNotConnected)
      expect(await reachable('1001')).toMatch(/^fake-drive-access-/)
      expect((await connectDrive(bob, origin, google, BOB)).status).toBe(200) // and Bob's own connection is a separate row
      expect(stored().map(row => row.user_id).sort()).toEqual(['1001', '1002'])
      expect(await reachable('1002')).not.toBe(await reachable('1001'))
    })

    it('go quiet for someone taken off the allowlist, keep their connection, and wake up when they return', async () => {
      const alice = await signedIn()
      const device = await deviceFor(alice)
      await connectDrive(alice, origin, google, ALICE)
      await boot({ allowedEmails: ['bob@example.com'] }) // Alice removed
      expect((await fetch(`${origin}/v1/drive`, { headers: { Authorization: `Bearer ${device}` } })).status).toBe(401)
      await expect(reachable('1001')).rejects.toBeInstanceOf(DriveNotConnected)
      expect(stored()).toHaveLength(1) // not deleted
      await boot({ allowedEmails: ['alice@example.com'] })
      expect(await drive(device)).toMatchObject({ connected: true })
      expect(await reachable('1001')).toMatch(/^fake-drive-access-/) // renewed from the stored token, after a restart
    })

    it('are off when Drive is off', async () => {
      await boot({ driveEnabled: false, tokenEncryptionKey: '' })
      const browser = await signedIn()
      expect((await browser.fetch(`${origin}/auth/drive/start`)).status).toBe(404)
      expect(await drive(await deviceFor(browser))).toEqual({ enabled: false, connected: false, canConnect: false, connectPath: null })
      expect((await fetch(`${origin}/v1/drive/disconnect`, { method: 'POST', headers: { Authorization: `Bearer ${INGEST}` } })).status).toBe(501)
      expect(server?.app.drive).toBeNull()
    })
  })

  it('keeps every secret out of the logs', async () => {
    const logged: string[] = []
    for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
    const browser = await signedIn()
    await connectDrive(browser, origin, google, ALICE)
    await connectDrive(browser, origin, google, ALICE, { scope: 'openid' })
    google.revokeAccount('1001')
    await (server?.app.drive as DriveAccounts).disconnect('1001')
    const everything = logged.join('\n')
    for (const secret of [CLIENT_SECRET, ...google.issuedRefreshTokens(), 'fake-drive-access', 'fake-drive-code', browser.cookie('vb_session') as string]) expect(everything).not.toContain(secret)
  })
})

describe('refusing to run without a key', () => {
  const base = { INGEST_TOKEN: 'a-long-enough-ingest-token', PUBLIC_URL: 'https://vb.example.com', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }

  it('will not start with Drive on and no key, a malformed key, or no Google sign-in; and never prints the key', () => {
    expect(() => loadConfig({ ...base, DRIVE_ENABLED: '1' })).toThrow(/TOKEN_ENCRYPTION_KEY/)
    const bad = 'this-is-not-a-valid-key-but-it-is-secret-1234'
    let message = ''
    try { loadConfig({ ...base, DRIVE_ENABLED: '1', TOKEN_ENCRYPTION_KEY: bad }) } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/32 random bytes/)
    expect(message).not.toContain(bad)
    expect(() => loadConfig({ ...base, TOKEN_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toThrow(/32 random bytes/)
    expect(() => loadConfig({ INGEST_TOKEN: base.INGEST_TOKEN, DRIVE_ENABLED: '1', TOKEN_ENCRYPTION_KEY: KEY })).toThrow(/Google sign-in/)
  })

  it('starts with Drive on and a good key, and with Drive off and no key', () => {
    expect(loadConfig({ ...base, DRIVE_ENABLED: '1', TOKEN_ENCRYPTION_KEY: KEY })).toMatchObject({ driveEnabled: true, tokenEncryptionKey: KEY })
    expect(loadConfig(base)).toMatchObject({ driveEnabled: false, tokenEncryptionKey: '' })
  })

  it('also refuses when the app is built without one, so a config assembled in code cannot skip the check', async () => {
    const dir = await tempDir()
    try {
      expect(() => createApp(testConfig(dir.dir, { publicUrl: 'http://x.test', googleClientId: 'a', googleClientSecret: 'b', driveEnabled: true, tokenEncryptionKey: '' }))).toThrow(/TOKEN_ENCRYPTION_KEY/)
    } finally { await dir.clean() }
  })
})
