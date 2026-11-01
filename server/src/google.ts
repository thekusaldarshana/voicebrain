import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import { OWNER_ID, type Profile } from './users.ts'

export interface GoogleEndpoints { authorize: string; token: string; jwks: string; revoke: string; userinfo: string; issuers: string[] }

/** The only Drive permission asked for: files this app creates or that the person opens with it. Not their whole Drive. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export const GOOGLE: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
}

/** A sign-in that failed for a reason the person can be told about. The message never contains a token or a code. */
export class SignInError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export interface GoogleOptions {
  clientId: string
  clientSecret: string
  /** PUBLIC_URL + /auth/google/callback */
  redirectUri: string
  /** PUBLIC_URL + /auth/drive/callback. Without it Drive cannot be connected. */
  driveRedirectUri?: string
  endpoints?: GoogleEndpoints
  now?: () => number
}

interface Login { purpose: 'signin' | 'drive'; userId: string; nonce: string; verifier: string; next: string; expiresAt: number }

/** What Google handed over when a person connected their Drive. The refresh token is the only long-lived part. */
export interface DriveGrant { refreshToken: string; accessToken: string; expiresIn: number }

interface TokenResponse { id_token?: unknown; access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown }

const LOGIN_SECONDS = 600
const MAX_LOGINS = 500
const JWKS_TTL_MS = 3_600_000
const JWKS_RETRY_MS = 60_000
const sha256url = (value: string) => createHash('sha256').update(value).digest('base64url')
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
const json = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
  return value as Record<string, unknown>
}
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').trim().slice(0, max) : '')

/**
 * Google sign-in with OpenID Connect: authorization code + PKCE, scopes `openid email profile` only. The ID token
 * is checked here (RS256 signature against Google's published keys, issuer, audience, expiry, nonce, verified
 * email) rather than trusted because it arrived over TLS. Nothing secret is ever logged or put in an error.
 */
export class GoogleAuth {
  private readonly options: GoogleOptions
  private readonly endpoints: GoogleEndpoints
  private readonly now: () => number
  private readonly logins = new Map<string, Login>()
  private keys = new Map<string, KeyObject>()
  private keysAt = 0
  private keysTried = 0
  private loading: Promise<void> | null = null

  constructor(options: GoogleOptions) {
    this.options = options
    this.endpoints = options.endpoints ?? GOOGLE
    this.now = options.now ?? Date.now
  }

  private sweep() {
    for (const [state, login] of this.logins) if (login.expiresAt < this.now()) this.logins.delete(state)
  }

  /** Step 1: where to send the browser. `next` is a local path to return to afterwards. */
  begin(next: string): { url: string; state: string } {
    this.sweep()
    if (this.logins.size >= MAX_LOGINS) throw new SignInError(429, 'Too many sign-ins are in progress. Try again in a few minutes.')
    const state = randomBytes(24).toString('base64url')
    const login: Login = { purpose: 'signin', userId: '', nonce: randomBytes(24).toString('base64url'), verifier: randomBytes(48).toString('base64url'), next, expiresAt: this.now() + LOGIN_SECONDS * 1000 }
    this.logins.set(state, login)
    const url = new URL(this.endpoints.authorize)
    url.search = new URLSearchParams({
      client_id: this.options.clientId, redirect_uri: this.options.redirectUri, response_type: 'code', scope: 'openid email profile',
      state, nonce: login.nonce, code_challenge: sha256url(login.verifier), code_challenge_method: 'S256', prompt: 'select_account',
    }).toString()
    return { url: url.href, state }
  }

  /** Step 2: Google sent the browser back. Exchange the code, verify the ID token, and say who signed in. */
  async finish(params: { code?: unknown; state?: unknown; error?: unknown }, expectedState: string): Promise<{ profile: Profile; next: string }> {
    this.sweep()
    const state = typeof params.state === 'string' ? params.state : ''
    const login = state ? this.logins.get(state) : undefined
    if (state) this.logins.delete(state) // one try per sign-in, whatever happens next
    if (!login || login.purpose !== 'signin' || !expectedState || !same(state, expectedState)) throw new SignInError(400, 'This sign-in expired or did not start here. Start again.')
    if (typeof params.error === 'string') throw new SignInError(400, 'Google sign-in was cancelled.')
    if (typeof params.code !== 'string' || !params.code) throw new SignInError(400, 'Google did not send a sign-in code. Start again.')
    const body = await this.exchange(params.code, login.verifier, this.options.redirectUri)
    if (typeof body.id_token !== 'string') throw new SignInError(502, 'Google did not accept the sign-in. Start again.')
    return { profile: await this.verifyIdToken(body.id_token, login.nonce), next: login.next }
  }

  /**
   * Connecting Drive is a second, separate consent: only the Drive scope, asked for on top of what the person already
   * granted, with a long-lived (offline) token and a fresh consent screen so Google actually issues one. It has its own
   * state, PKCE verifier and same-browser cookie, and it belongs to the signed-in user who started it.
   */
  beginDrive(userId: string, email: string): { url: string; state: string } {
    if (!this.options.driveRedirectUri) throw new SignInError(501, 'Google Drive is not set up on this server.')
    this.sweep()
    if (this.logins.size >= MAX_LOGINS) throw new SignInError(429, 'Too many sign-ins are in progress. Try again in a few minutes.')
    const state = randomBytes(24).toString('base64url')
    const login: Login = { purpose: 'drive', userId, nonce: randomBytes(24).toString('base64url'), verifier: randomBytes(48).toString('base64url'), next: '', expiresAt: this.now() + LOGIN_SECONDS * 1000 }
    this.logins.set(state, login)
    const url = new URL(this.endpoints.authorize)
    url.search = new URLSearchParams({
      client_id: this.options.clientId, redirect_uri: this.options.driveRedirectUri, response_type: 'code', scope: DRIVE_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', login_hint: email,
      state, nonce: login.nonce, code_challenge: sha256url(login.verifier), code_challenge_method: 'S256',
    }).toString()
    return { url: url.href, state }
  }

  /**
   * Google sent the browser back from the Drive consent. Refuses unless: the state is ours, from this browser, for this
   * user; Google really granted drive.file (people can untick it); a refresh token came with it; and the Google account
   * that consented is the one signed in (a different account's Drive must never be filed under this user).
   */
  async finishDrive(params: { code?: unknown; state?: unknown; error?: unknown }, expectedState: string, userId: string): Promise<DriveGrant> {
    this.sweep()
    const state = typeof params.state === 'string' ? params.state : ''
    const login = state ? this.logins.get(state) : undefined
    if (state) this.logins.delete(state)
    if (!login || login.purpose !== 'drive' || login.userId !== userId || !expectedState || !same(state, expectedState)) throw new SignInError(400, 'This Drive connection expired or did not start here. Start again.')
    if (typeof params.error === 'string') throw new SignInError(400, 'Connecting Google Drive was cancelled.')
    if (typeof params.code !== 'string' || !params.code) throw new SignInError(400, 'Google did not send a code. Start again.')
    const body = await this.exchange(params.code, login.verifier, this.options.driveRedirectUri ?? '')
    const access = typeof body.access_token === 'string' ? body.access_token : ''
    const refresh = typeof body.refresh_token === 'string' ? body.refresh_token : ''
    const undo = async (reason: SignInError) => { await this.revoke(refresh || access); return reason }
    if (!access) throw new SignInError(502, 'Google did not accept the Drive connection. Start again.')
    if (typeof body.scope !== 'string' || !body.scope.split(' ').includes(DRIVE_SCOPE)) throw await undo(new SignInError(403, 'Google Drive access was not granted. On Google’s screen, tick the box that lets voicebrain use Drive files, then try again.'))
    if (!refresh) throw await undo(new SignInError(502, 'Google did not give a lasting Drive connection. Remove voicebrain at myaccount.google.com/permissions and try again.'))
    if ((await this.subjectOf(access)) !== userId) throw await undo(new SignInError(403, 'That is a different Google account from the one you are signed in with. Choose the same account.'))
    return { refreshToken: refresh, accessToken: access, expiresIn: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600 }
  }

  /** Who Google says an access token belongs to. Asked of Google itself over TLS, so no nonce is needed. */
  private async subjectOf(accessToken: string): Promise<string> {
    try {
      const response = await fetch(this.endpoints.userinfo, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) })
      const body = (await response.json().catch(() => null)) as { sub?: unknown } | null
      return response.ok && typeof body?.sub === 'string' ? body.sub : ''
    } catch { return '' }
  }

  /** Tells Google to forget a token. Best effort: it is for tidiness, so failing must not stop anything. */
  async revoke(token: string): Promise<boolean> {
    if (!token) return false
    try {
      const response = await fetch(this.endpoints.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(5_000) })
      return response.ok
    } catch { return false }
  }

  private async exchange(code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
    let response: Response
    try {
      response = await fetch(this.endpoints.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.options.clientId, client_secret: this.options.clientSecret, redirect_uri: redirectUri, code_verifier: verifier }),
      })
    } catch { throw new SignInError(502, 'Could not reach Google. Try again.') }
    const body = (await response.json().catch(() => null)) as TokenResponse | null
    if (!response.ok || !body) {
      console.error(`google token exchange failed (${response.status}${typeof body?.error === 'string' ? `, ${clean(body.error, 40)}` : ''})`)
      throw new SignInError(502, 'Google did not accept the sign-in. Start again.')
    }
    return body
  }

  private async loadKeys(): Promise<void> {
    this.keysTried = this.now()
    try {
      const response = await fetch(this.endpoints.jwks, { signal: AbortSignal.timeout(10_000) })
      const body = (await response.json()) as { keys?: Array<Record<string, unknown>> }
      if (!response.ok || !Array.isArray(body.keys)) throw new Error('bad key set')
      const fresh = new Map<string, KeyObject>()
      for (const jwk of body.keys) {
        if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue
        try { fresh.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })) } catch { /* skip a key we cannot read */ }
      }
      this.keys = fresh
      this.keysAt = this.now()
    } catch { throw new SignInError(502, 'Could not fetch Google’s signing keys. Try again.') }
  }

  private async key(kid: string): Promise<KeyObject | null> {
    const stale = this.now() - this.keysAt > JWKS_TTL_MS
    // Sign-ins that arrive while keys are being fetched wait for that one fetch instead of giving up.
    if (this.loading) await this.loading
    // An unknown key id may mean Google rotated its keys: look again, but not more than once a minute.
    else if ((stale || !this.keys.has(kid)) && this.now() - this.keysTried > JWKS_RETRY_MS) {
      this.loading = this.loadKeys().finally(() => { this.loading = null })
      await this.loading
    }
    return this.keys.get(kid) ?? null
  }

  /** Verifies the ID token and returns the profile. Exposed for tests; throws SignInError on any failure. */
  async verifyIdToken(idToken: string, nonce: string): Promise<Profile> {
    const bad = (why: string) => new SignInError(401, `Google sign-in could not be verified (${why}).`)
    const parts = idToken.split('.')
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw bad('malformed')
    const [head, body, signature] = parts as [string, string, string]
    let header: Record<string, unknown>
    let claims: Record<string, unknown>
    try { header = json(head); claims = json(body) } catch { throw bad('malformed') }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw bad('algorithm')
    const key = await this.key(header.kid)
    if (!key || !verify('RSA-SHA256', Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))) throw bad('signature')

    const seconds = Math.floor(this.now() / 1000)
    if (typeof claims.iss !== 'string' || !this.endpoints.issuers.includes(claims.iss)) throw bad('issuer')
    const audience = claims.aud
    const aud = Array.isArray(audience) ? audience : [audience]
    if (!aud.includes(this.options.clientId) || (aud.length > 1 && claims.azp !== this.options.clientId)) throw bad('audience')
    if (typeof claims.exp !== 'number' || claims.exp <= seconds) throw bad('expired')
    if (typeof claims.iat === 'number' && claims.iat > seconds + 300) throw bad('issued in the future')
    if (typeof claims.nonce !== 'string' || !same(claims.nonce, nonce)) throw bad('nonce')
    if (claims.email_verified !== true && claims.email_verified !== 'true') throw new SignInError(403, 'Your Google email address is not verified.')
    // The id becomes a folder name (data/users/<id>) and a storage key, so it must be a plain word and never the owner identity.
    const sub = clean(claims.sub, 64)
    const email = clean(claims.email, 254).toLowerCase()
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sub) || sub === OWNER_ID || !/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('identity')
    return { sub, email, name: clean(claims.name, 100) || email }
  }
}
