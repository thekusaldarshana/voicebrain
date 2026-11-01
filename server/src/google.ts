import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import { OWNER_ID, type Profile } from './users.ts'

export interface GoogleEndpoints { authorize: string; token: string; jwks: string; issuers: string[] }

export const GOOGLE: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
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
  endpoints?: GoogleEndpoints
  now?: () => number
}

interface Login { nonce: string; verifier: string; next: string; expiresAt: number }

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
    const login: Login = { nonce: randomBytes(24).toString('base64url'), verifier: randomBytes(48).toString('base64url'), next, expiresAt: this.now() + LOGIN_SECONDS * 1000 }
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
    if (!login || !expectedState || !same(state, expectedState)) throw new SignInError(400, 'This sign-in expired or did not start here. Start again.')
    if (typeof params.error === 'string') throw new SignInError(400, 'Google sign-in was cancelled.')
    if (typeof params.code !== 'string' || !params.code) throw new SignInError(400, 'Google did not send a sign-in code. Start again.')
    const idToken = await this.exchange(params.code, login.verifier)
    return { profile: await this.verifyIdToken(idToken, login.nonce), next: login.next }
  }

  private async exchange(code: string, verifier: string): Promise<string> {
    let response: Response
    try {
      response = await fetch(this.endpoints.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.options.clientId, client_secret: this.options.clientSecret, redirect_uri: this.options.redirectUri, code_verifier: verifier }),
      })
    } catch { throw new SignInError(502, 'Could not reach Google. Try again.') }
    const body = (await response.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null
    if (!response.ok || typeof body?.id_token !== 'string') {
      console.error(`google token exchange failed (${response.status}${typeof body?.error === 'string' ? `, ${clean(body.error, 40)}` : ''})`)
      throw new SignInError(502, 'Google did not accept the sign-in. Start again.')
    }
    return body.id_token
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
