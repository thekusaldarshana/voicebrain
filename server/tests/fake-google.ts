import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { GoogleEndpoints } from '../src/google.ts'

export const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
export const CLIENT_SECRET = 'test-client-secret'

export interface Identity { sub: string; email: string; name?: string; email_verified?: boolean | string }
/** Ways to make the ID token wrong. `undefined` keeps the honest value. */
export interface Tamper { aud?: string | string[]; azp?: string; iss?: string; nonce?: string; exp?: number; iat?: number; alg?: string; signWith?: 'other-key' | 'none'; kid?: string }
export interface AuthRequest { nonce: string; challenge: string; redirectUri: string }

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const makeKey = (kid: string) => { const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }); return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } } }
type Key = ReturnType<typeof makeKey>

/** A stand-in for Google: a token endpoint that really checks the client secret, redirect and PKCE verifier, and a JWKS. */
export class FakeGoogle {
  readonly endpoints: GoogleEndpoints
  readonly url: string
  tokenCalls = 0
  jwksCalls = 0
  private readonly server: Server
  private keys: Key[]
  private readonly other = makeKey('other')
  private readonly codes = new Map<string, { request: AuthRequest; idToken: string }>()
  private counter = 0

  private constructor(server: Server, url: string) {
    this.server = server
    this.url = url
    this.keys = [makeKey('key-1')]
    this.endpoints = { authorize: `${url}/authorize`, token: `${url}/token`, jwks: `${url}/certs`, issuers: ['https://accounts.google.com', 'accounts.google.com'] }
  }

  static async start(): Promise<FakeGoogle> {
    let self: FakeGoogle | null = null
    const server = createServer(async (req, res) => {
      const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (!self) { reply(503, {}); return }
      if (req.url === '/certs') { self.jwksCalls += 1; reply(200, { keys: self.keys.map(key => key.jwk) }); return }
      if (req.url === '/token' && req.method === 'POST') { const [status, body] = await self.token(req); reply(status, body); return }
      reply(404, {})
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    self = new FakeGoogle(server, `http://127.0.0.1:${(server.address() as { port: number }).port}`)
    return self
  }

  /** Google rotates its keys: from now on tokens are signed with a new key id, and the old key is gone. */
  rotate() { this.counter += 1; this.keys = [makeKey(`key-${this.counter + 1}`)] }

  /** What Google does after the person logs in: it makes a code that stands for this identity. Returns the code. */
  issue(request: AuthRequest, identity: Identity, tamper: Tamper = {}): string {
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, unknown> = {
      iss: tamper.iss ?? 'https://accounts.google.com', aud: tamper.aud ?? CLIENT_ID, azp: tamper.azp ?? CLIENT_ID, sub: identity.sub, email: identity.email, name: identity.name ?? 'Test Person',
      email_verified: identity.email_verified ?? true, nonce: tamper.nonce ?? request.nonce, iat: tamper.iat ?? now, exp: tamper.exp ?? now + 3600,
    }
    const key = this.keys[0] as Key
    const header = b64({ alg: tamper.alg ?? 'RS256', typ: 'JWT', kid: tamper.kid ?? key.kid })
    const payload = b64(claims)
    let signature = ''
    if (tamper.signWith !== 'none') signature = sign(`${header}.${payload}`, tamper.signWith === 'other-key' ? this.other.privateKey : key.privateKey)
    const code = `fake-code-${randomBytes(12).toString('base64url')}`
    this.codes.set(code, { request, idToken: `${header}.${payload}.${signature}` })
    return code
  }

  private async token(req: IncomingMessage): Promise<[number, unknown]> {
    this.tokenCalls += 1
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    const entry = this.codes.get(form.get('code') ?? '')
    this.codes.delete(form.get('code') ?? '') // codes work once
    const verifier = form.get('code_verifier') ?? ''
    const ok = entry && form.get('grant_type') === 'authorization_code' && form.get('client_id') === CLIENT_ID && form.get('client_secret') === CLIENT_SECRET
      && form.get('redirect_uri') === entry.request.redirectUri && createHash('sha256').update(verifier).digest('base64url') === entry.request.challenge
    return ok ? [200, { access_token: 'fake-access', token_type: 'Bearer', expires_in: 3599, id_token: entry.idToken }] : [400, { error: 'invalid_grant' }]
  }

  close() { return new Promise<void>(done => { this.server.closeAllConnections?.(); this.server.close(() => done()) }) }
}

function sign(data: string, key: KeyObject) { return createSign('RSA-SHA256').update(data).sign(key).toString('base64url') }

/** Just enough of a browser: it keeps cookies and never follows redirects by itself, so a test sees each hop. */
export class Browser {
  private readonly jar = new Map<string, string>()

  private remember(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (attributes.some(attribute => /^\s*max-age=0\s*$/i.test(attribute)) || value === '') this.jar.delete(name); else this.jar.set(name, value)
    }
  }

  cookie(name: string) { return this.jar.get(name) }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([name, value]) => `${name}=${value}`).join('; '))
    const response = await fetch(url, { ...init, headers, redirect: 'manual' })
    this.remember(response)
    return response
  }

  form(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
    return this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) })
  }
}

/**
 * Walks the sign-in the way a browser would: start (a redirect to "Google"), log in there, come back to the callback.
 * Returns the callback's response, so a test can check what the server did with the (maybe tampered) token.
 */
export async function signIn(browser: Browser, base: string, google: FakeGoogle, identity: Identity, options: { next?: string; tamper?: Tamper } = {}): Promise<Response> {
  const start = await browser.fetch(`${base}/auth/google/start${options.next ? `?next=${encodeURIComponent(options.next)}` : ''}`)
  if (start.status !== 302) throw new Error(`start gave ${start.status}`)
  return finishSignIn(browser, google, identity, start.headers.get('location') as string, options.tamper)
}

/** From the redirect to Google onwards. Split out so a test can sign in from a redirect it already holds. */
export async function finishSignIn(browser: Browser, google: FakeGoogle, identity: Identity, googleUrl: string, tamper?: Tamper): Promise<Response> {
  const url = new URL(googleUrl)
  const get = (name: string) => url.searchParams.get(name) as string
  if (!googleUrl.startsWith(google.url)) throw new Error('not sent to the fake Google')
  const code = google.issue({ nonce: get('nonce'), challenge: get('code_challenge'), redirectUri: get('redirect_uri') }, identity, tamper)
  return browser.fetch(`${get('redirect_uri')}?${new URLSearchParams({ code, state: get('state') })}`)
}
