import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { authMode, loadConfig, type Config } from '../src/config.ts'
import { GoogleAuth, SignInError } from '../src/google.ts'
import { OWNER_ID, Users } from '../src/users.ts'
import { safeNext } from '../src/auth.ts'
import { Browser, CLIENT_ID, CLIENT_SECRET, FakeGoogle, finishSignIn, signIn, type Identity, type Tamper } from './fake-google.ts'
import { freePort, run, tempDir, testConfig, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const BOB: Identity = { sub: '1002', email: 'bob@example.com', name: 'Bob' }

let google: FakeGoogle
beforeAll(async () => { google = await FakeGoogle.start() })
afterAll(async () => { await google.close() })

let dir: Awaited<ReturnType<typeof tempDir>>
let server: Running | null = null
let origin = ''
let logged: string[] = []

async function boot(overrides: Partial<Config> = {}) {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = await run(testConfig(dir.dir, { port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, workerEnabled: false, ...overrides }), fetch, { googleEndpoints: google.endpoints })
}
const users = () => { const db = new DatabaseSync(join(dir.dir, 'users.sqlite')); const rows = db.prepare('SELECT id, email, name, created_at FROM users ORDER BY created_at').all() as Array<{ id: string; email: string; name: string; created_at: string }>; db.close(); return rows }

beforeEach(async () => {
  dir = await tempDir()
  logged = []
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
})
afterEach(async () => { vi.restoreAllMocks(); await server?.stop(); server = null; await dir.clean() })

describe('Google sign-in: the happy path', () => {
  beforeEach(() => boot())

  it('sends the browser to Google with PKCE, a state and a nonce, and only the openid/email/profile scopes', async () => {
    const response = await new Browser().fetch(`${origin}/auth/google/start`)
    expect(response.status).toBe(302)
    const url = new URL(response.headers.get('location') as string)
    expect(`${url.origin}${url.pathname}`).toBe(`${google.url}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT_ID, response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256', redirect_uri: `${origin}/auth/google/callback` })
    for (const name of ['state', 'nonce', 'code_challenge']) expect((url.searchParams.get(name) ?? '').length).toBeGreaterThan(20)
    expect(url.href).not.toContain(CLIENT_SECRET)
  })

  it('verifies the ID token, stores the user under their Google id, and starts a session', async () => {
    const browser = new Browser()
    const response = await signIn(browser, origin, google, ALICE)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    const cookie = response.headers.getSetCookie().find(line => line.startsWith('vb_session=')) as string
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).not.toMatch(/Secure/) // the test server is plain http
    expect(users()).toMatchObject([{ id: '1001', email: 'alice@example.com', name: 'Alice' }])
    expect((await browser.fetch(`${origin}/pair`)).status).toBe(200) // the session opens pages that need one
  })

  it('returns the person to the page they were on, and never to another site', async () => {
    const ok = await signIn(new Browser(), origin, google, ALICE, { next: '/pair?code=ABCD-EFGH' })
    expect(ok.headers.get('location')).toBe('/pair?code=ABCD-EFGH')
    for (const next of ['https://evil.test/', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', '/ok\r\nSet-Cookie: x=1']) {
      expect(safeNext(next)).toBe('/')
    }
    const evil = await signIn(new Browser(), origin, google, ALICE, { next: '//evil.test/steal' })
    expect(evil.headers.get('location')).toBe('/')
  })

  it('keeps every secret out of the logs', async () => {
    const browser = new Browser()
    await signIn(browser, origin, google, ALICE)
    await signIn(new Browser(), origin, google, BOB) // refused: the instance is claimed
    await signIn(new Browser(), origin, google, ALICE, { tamper: { nonce: 'wrong' } })
    const everything = logged.join('\n')
    for (const secret of [CLIENT_SECRET, browser.cookie('vb_session') as string, 'fake-code-', 'fake-access', '.eyJ']) expect(everything).not.toContain(secret)
    expect(everything).not.toContain('alice@example.com')
  })

  it('ends the session on sign-out, and refuses a sign-out that another site started', async () => {
    const browser = new Browser()
    await signIn(browser, origin, google, ALICE)
    expect((await browser.fetch(`${origin}/auth/logout`, { method: 'POST', headers: { Origin: 'https://evil.test' } })).status).toBe(403)
    expect((await browser.fetch(`${origin}/pair`)).status).toBe(200)
    const cookie = browser.cookie('vb_session') as string
    expect((await browser.fetch(`${origin}/auth/logout`, { method: 'POST', headers: { Origin: origin } })).status).toBe(204)
    expect(browser.cookie('vb_session')).toBeUndefined()
    const replay = await fetch(`${origin}/pair`, { headers: { cookie: `vb_session=${cookie}` }, redirect: 'manual' })
    expect(replay.status).toBe(302) // the old cookie is dead
  })
})

describe('Google sign-in: a token that is not right is refused', () => {
  beforeEach(() => boot())
  const cases: Array<[string, Tamper, number]> = [
    ['an audience that is another app', { aud: 'someone-elses-client-id' }, 401],
    ['several audiences without our azp', { aud: [CLIENT_ID, 'other'], azp: 'other' }, 401],
    ['an issuer that is not Google', { iss: 'https://evil.example.com' }, 401],
    ['a nonce from another sign-in', { nonce: 'not-the-nonce-we-sent' }, 401],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 10 }, 401],
    ['a token issued in the future', { iat: Math.floor(Date.now() / 1000) + 3600 }, 401],
    ['alg none and no signature', { alg: 'none', signWith: 'none' }, 401],
    ['alg HS256', { alg: 'HS256' }, 401],
    ['a signature from some other key', { signWith: 'other-key' }, 401],
    ['a key id Google never published', { kid: 'made-up' }, 401],
  ]
  it.each(cases)('refuses %s', async (_name, tamper, status) => {
    const browser = new Browser()
    const response = await signIn(browser, origin, google, ALICE, { tamper })
    expect(response.status).toBe(status)
    expect(browser.cookie('vb_session')).toBeUndefined()
    expect(users()).toEqual([]) // and nobody was signed up, so nobody claimed the instance
    expect((await signIn(new Browser(), origin, google, ALICE)).status).toBe(302) // an honest sign-in afterwards still works
  })

  it('refuses an address Google has not verified', async () => {
    for (const email_verified of [false, 'false'] as const) {
      const response = await signIn(new Browser(), origin, google, { ...ALICE, email_verified })
      expect(response.status).toBe(403)
      expect(await response.text()).toContain('not verified')
    }
    expect(users()).toEqual([])
  })

  it('accepts the string "true", which Google has used for email_verified', async () => {
    expect((await signIn(new Browser(), origin, google, { ...ALICE, email_verified: 'true' })).status).toBe(302)
  })
})

describe('Google sign-in: state, PKCE and the code exchange', () => {
  beforeEach(() => boot())

  it('lets a sign-in finish once only', async () => {
    const browser = new Browser()
    const start = await browser.fetch(`${origin}/auth/google/start`)
    const googleUrl = start.headers.get('location') as string
    const url = new URL(googleUrl)
    const code = google.issue({ nonce: url.searchParams.get('nonce') as string, challenge: url.searchParams.get('code_challenge') as string, redirectUri: url.searchParams.get('redirect_uri') as string }, ALICE)
    const callback = `${origin}/auth/google/callback?${new URLSearchParams({ code, state: url.searchParams.get('state') as string })}`
    expect((await browser.fetch(callback)).status).toBe(302)
    expect((await browser.fetch(callback)).status).toBe(400) // replayed
  })

  it('refuses a callback from a browser that did not start the sign-in', async () => {
    const victim = new Browser()
    const attackerStart = await new Browser().fetch(`${origin}/auth/google/start`)
    const url = new URL(attackerStart.headers.get('location') as string)
    const before = google.tokenCalls
    const code = google.issue({ nonce: url.searchParams.get('nonce') as string, challenge: url.searchParams.get('code_challenge') as string, redirectUri: url.searchParams.get('redirect_uri') as string }, ALICE)
    const response = await victim.fetch(`${origin}/auth/google/callback?${new URLSearchParams({ code, state: url.searchParams.get('state') as string })}`)
    expect(response.status).toBe(400)
    expect(victim.cookie('vb_session')).toBeUndefined()
    expect(google.tokenCalls).toBe(before) // the code was never even exchanged
  })

  it('refuses an invented state, a missing code, and a sign-in Google cancelled', async () => {
    const browser = new Browser()
    expect((await browser.fetch(`${origin}/auth/google/callback?code=x&state=invented`)).status).toBe(400)
    const start = await browser.fetch(`${origin}/auth/google/start`)
    const state = new URL(start.headers.get('location') as string).searchParams.get('state') as string
    expect((await browser.fetch(`${origin}/auth/google/callback?error=access_denied&state=${state}`)).status).toBe(400)
    const second = await browser.fetch(`${origin}/auth/google/start`)
    const state2 = new URL(second.headers.get('location') as string).searchParams.get('state') as string
    expect((await browser.fetch(`${origin}/auth/google/callback?state=${state2}`)).status).toBe(400)
    expect(users()).toEqual([])
  })

  it('proves the PKCE verifier to Google (the fake checks it) and fails cleanly when Google rejects the exchange', async () => {
    await server?.stop()
    await boot({ googleClientSecret: 'the-wrong-secret' })
    const response = await signIn(new Browser(), origin, google, ALICE)
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('the-wrong-secret')
    expect(logged.join('\n')).not.toContain('the-wrong-secret')
    expect(users()).toEqual([])
  })
})

describe('who may sign in', () => {
  it('lets the first person claim the instance and refuses everyone after, but not the owner coming back', async () => {
    await boot()
    expect((await signIn(new Browser(), origin, google, ALICE)).status).toBe(302)
    const later = await signIn(new Browser(), origin, google, BOB)
    expect(later.status).toBe(403)
    expect(await later.text()).toContain('already belongs to someone else')
    expect((await signIn(new Browser(), origin, google, { ...ALICE, email: 'alice.new@example.com' })).status).toBe(302) // same Google id, new address
    expect(users()).toMatchObject([{ id: '1001', email: 'alice.new@example.com' }])
  })

  it('with ALLOWED_EMAILS set, lets only those addresses in (any letter case) and nobody claims anything', async () => {
    await boot({ allowedEmails: ['bob@example.com', 'alice@example.com'] })
    const stranger = await signIn(new Browser(), origin, google, { sub: '9', email: 'mallory@example.com' })
    expect(stranger.status).toBe(403)
    expect(await stranger.text()).toContain('not on the list')
    expect((await signIn(new Browser(), origin, google, { ...BOB, email: 'Bob@Example.COM' })).status).toBe(302)
    expect((await signIn(new Browser(), origin, google, ALICE)).status).toBe(302) // a second allowed person is fine
    expect(users().map(user => user.id).sort()).toEqual(['1001', '1002'])
  })

  it('lets exactly one of two first sign-ins claim the instance when they arrive together', async () => {
    await boot()
    const [a, b] = [new Browser(), new Browser()]
    const startA = (await a.fetch(`${origin}/auth/google/start`)).headers.get('location') as string
    const startB = (await b.fetch(`${origin}/auth/google/start`)).headers.get('location') as string
    const [first, second] = await Promise.all([finishSignIn(a, google, ALICE, startA), finishSignIn(b, google, BOB, startB)])
    expect([first.status, second.status].sort()).toEqual([302, 403])
    expect(users()).toHaveLength(1)
  })

  it('makes the claim a database fact, so a second process cannot also claim it', () => {
    const path = join(dir.dir, 'race.sqlite')
    const one = new Users(path)
    const two = new Users(path)
    try {
      expect(one.signIn({ sub: 'a', email: 'a@example.com', name: 'A' })).toMatchObject({ ok: true, claimed: true })
      expect(two.signIn({ sub: 'b', email: 'b@example.com', name: 'B' })).toEqual({ ok: false, reason: 'instance-claimed' })
      expect(two.signIn({ sub: 'a', email: 'a@example.com', name: 'A' })).toMatchObject({ ok: true, claimed: false })
    } finally { one.close(); two.close() }
  })
})

describe('sessions follow the allowlist', () => {
  it('expire after two weeks, and stop working the moment the person comes off ALLOWED_EMAILS', () => {
    let now = Date.parse('2026-11-01T00:00:00Z')
    const path = join(dir.dir, 'sessions.sqlite')
    const open = new Users(path, { allowedEmails: ['a@example.com'], now: () => now })
    const { user } = open.signIn({ sub: 'a', email: 'a@example.com', name: 'A' }) as { ok: true; user: { id: string } }
    const { token } = open.createSession(user.id)
    expect(open.userForSession(token)?.id).toBe('a')
    expect(open.userForSession('not-a-session')).toBeNull()
    expect(open.isActive(OWNER_ID)).toBe(true)
    now += 13 * 86_400_000
    expect(open.userForSession(token)?.id).toBe('a')
    now += 2 * 86_400_000
    expect(open.userForSession(token)).toBeNull()
    const fresh = open.createSession('a').token
    open.close()
    const narrowed = new Users(path, { allowedEmails: ['someone-else@example.com'], now: () => now })
    expect(narrowed.userForSession(fresh)).toBeNull()
    expect(narrowed.isActive('a')).toBe(false)
    narrowed.close()
  })

  it('stores the session only as a hash', async () => {
    await boot()
    const browser = new Browser()
    await signIn(browser, origin, google, ALICE)
    const db = new DatabaseSync(join(dir.dir, 'users.sqlite'))
    const rows = JSON.stringify(db.prepare('SELECT * FROM sessions').all())
    db.close()
    expect(rows).not.toContain(browser.cookie('vb_session') as string)
  })
})

describe('Google keys', () => {
  const draw = async (now: () => number) => {
    const auth = new GoogleAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: 'http://app.test/auth/google/callback', endpoints: google.endpoints, now })
    const begin = auth.begin('/')
    const url = new URL(begin.url)
    const code = google.issue({ nonce: url.searchParams.get('nonce') as string, challenge: url.searchParams.get('code_challenge') as string, redirectUri: 'http://app.test/auth/google/callback' }, ALICE)
    return auth.finish({ code, state: begin.state }, begin.state)
  }

  it('looks again when Google rotates its keys, but not more than once a minute', async () => {
    let now = Date.now()
    const auth = new GoogleAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: 'http://app.test/auth/google/callback', endpoints: google.endpoints, now: () => now })
    const signInOnce = async () => {
      const begin = auth.begin('/')
      const url = new URL(begin.url)
      const code = google.issue({ nonce: url.searchParams.get('nonce') as string, challenge: url.searchParams.get('code_challenge') as string, redirectUri: 'http://app.test/auth/google/callback' }, ALICE)
      return auth.finish({ code, state: begin.state }, begin.state)
    }
    await signInOnce()
    const fetched = google.jwksCalls
    await signInOnce()
    expect(google.jwksCalls).toBe(fetched) // cached
    google.rotate()
    await expect(signInOnce()).rejects.toBeInstanceOf(SignInError) // unknown key, but we just looked: no hammering Google
    expect(google.jwksCalls).toBe(fetched)
    now += 61_000
    await expect(signInOnce()).resolves.toMatchObject({ profile: { sub: '1001' } })
    expect(google.jwksCalls).toBe(fetched + 1)
  })

  it('refuses a sign-in that takes too long to come back', async () => {
    let now = Date.now()
    const auth = new GoogleAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: 'http://app.test/auth/google/callback', endpoints: google.endpoints, now: () => now })
    const begin = auth.begin('/')
    now += 11 * 60_000
    await expect(auth.finish({ code: 'x', state: begin.state }, begin.state)).rejects.toThrow(/expired/)
    await expect(draw(() => now)).resolves.toBeTruthy()
  })
})

describe('configuration', () => {
  const base = { INGEST_TOKEN: 'a-long-enough-ingest-token', PUBLIC_URL: 'https://vb.example.com' }
  it('reads Google settings and a lower-cased allowlist, and chooses Google over the passphrase', () => {
    const config = loadConfig({ ...base, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', ALLOWED_EMAILS: ' Me@Example.com, you@example.com ;', OWNER_PASSPHRASE: 'a long passphrase here' })
    expect(config).toMatchObject({ googleClientId: 'id', allowedEmails: ['me@example.com', 'you@example.com'] })
    expect(authMode(config)).toBe('google')
    expect(authMode(loadConfig({ ...base, OWNER_PASSPHRASE: 'a long passphrase here' }))).toBe('passphrase')
    expect(authMode(loadConfig(base))).toBe('none')
  })
  it('refuses half a Google setup, a missing PUBLIC_URL, and something that is not an email', () => {
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: 'id' })).toThrow(/both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/)
    expect(() => loadConfig({ INGEST_TOKEN: base.INGEST_TOKEN, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' })).toThrow(/PUBLIC_URL/)
    expect(() => loadConfig({ ...base, ALLOWED_EMAILS: 'me@example.com, nope' })).toThrow(/ALLOWED_EMAILS/)
  })
})
