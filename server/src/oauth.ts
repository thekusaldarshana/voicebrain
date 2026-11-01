import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { DatabaseSync } from 'node:sqlite'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureColumn } from './sqlite.ts'
import { OWNER_ID } from './users.ts'

const ACCESS_SECONDS = 3600
const REFRESH_SECONDS = 90 * 86_400
const CODE_SECONDS = 300
const SCOPE = 'mcp'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)

/** Counts wrong passphrases per address and per server, so the approval page cannot be guessed at. */
export class Throttle {
  private readonly perKey = new Map<string, number[]>()
  private globalFailures: number[] = []
  private readonly now: () => number
  private readonly limits: { perKey: number; global: number }

  constructor(now: () => number = Date.now, limits: { perKey?: number; global?: number } = {}) { this.now = now; this.limits = { perKey: limits.perKey ?? 5, global: limits.global ?? 20 } }

  blocked(key: string): boolean {
    const cutoff = this.now() - 10 * 60_000
    const mine = (this.perKey.get(key) ?? []).filter(at => at > cutoff)
    this.perKey.set(key, mine)
    this.globalFailures = this.globalFailures.filter(at => at > this.now() - 60 * 60_000)
    return mine.length >= this.limits.perKey || this.globalFailures.length >= this.limits.global
  }

  failed(key: string) {
    this.perKey.set(key, [...(this.perKey.get(key) ?? []), this.now()])
    this.globalFailures.push(this.now())
  }
}

/**
 * Who may approve an assistant's request. `google`: a person signed in with Google (a browser session); the
 * provider sends everyone else to sign in first. `passphrase`: the legacy owner passphrase, used only when Google
 * sign-in is not configured.
 */
export type Approver =
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'google'; userOf: (req: Request) => { id: string; email: string } | null; signInUrl: (next: string) => string; originOk: (req: Request) => boolean }

export interface OwnerOAuthOptions { dbPath: string; approver: Approver; staticToken: string; isActive?: (userId: string) => boolean; now?: () => number }

/**
 * A minimal OAuth 2.1 server (dynamic client registration, PKCE, refresh tokens). Anyone can register a client,
 * but nothing is issued until a signed-in, allowed person taps Approve on the consent page (or, in legacy mode,
 * types the owner passphrase). Every code and token carries the id of the person who approved it.
 * Tokens are stored only as SHA-256 hashes.
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore
  readonly throttle: Throttle
  private readonly db: DatabaseSync
  private readonly approver: Approver
  private readonly isActive: (userId: string) => boolean
  private readonly staticToken: string
  private readonly now: () => number

  constructor(options: OwnerOAuthOptions) {
    this.now = options.now ?? Date.now
    this.approver = options.approver
    this.isActive = options.isActive ?? (() => true)
    this.staticToken = options.staticToken
    this.throttle = new Throttle(this.now)
    if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true })
    this.db = new DatabaseSync(options.dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS oauth_clients(client_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_pending(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, json TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL, attempted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_tokens(hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
    `)
    // Codes and tokens issued before sign-in existed belong to the owner identity.
    for (const table of ['oauth_codes', 'oauth_tokens']) ensureColumn(this.db, table, 'user_id', `TEXT NOT NULL DEFAULT '${OWNER_ID}'`)
    this.clientsStore = {
      getClient: id => {
        const row = this.db.prepare('SELECT json FROM oauth_clients WHERE client_id = ?').get(id) as { json: string } | undefined
        return row ? (JSON.parse(row.json) as OAuthClientInformationFull) : undefined
      },
      registerClient: client => {
        const full = client as OAuthClientInformationFull
        this.db.prepare('INSERT OR REPLACE INTO oauth_clients VALUES (?, ?)').run(full.client_id, JSON.stringify(full))
        return full
      },
    }
  }

  close() { this.db.close() }

  private seconds() { return Math.floor(this.now() / 1000) }

  private sweep() {
    const at = this.seconds()
    for (const table of ['oauth_pending', 'oauth_codes', 'oauth_tokens']) this.db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(at)
  }

  /** Step 1: the client sent the person here. Show the consent page, after sending them to sign in if they are not. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep()
    const id = token()
    this.db.prepare('INSERT INTO oauth_pending VALUES (?, ?, ?, ?)').run(id, client.client_id, JSON.stringify({ state: params.state, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri, resource: params.resource?.href }), this.seconds() + 600)
    this.show(res.req, res, id, client)
  }

  /** Where the sign-in page sends the person back to, with the request they started. */
  async resume(req: Request, res: Response): Promise<void> {
    const id = String(req.query.request ?? '')
    const row = this.db.prepare('SELECT client_id, expires_at FROM oauth_pending WHERE id = ?').get(id) as { client_id: string; expires_at: number } | undefined
    const client = row && row.expires_at >= this.seconds() ? (this.clientsStore.getClient(row.client_id) as OAuthClientInformationFull | undefined) : undefined
    if (!client) { res.status(400).type('text').send('This approval request expired. Start again from your assistant.'); return }
    this.show(req, res, id, client)
  }

  private show(req: Request, res: Response, id: string, client: OAuthClientInformationFull) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    if (this.approver.kind === 'google') {
      const user = this.approver.userOf(req)
      if (!user) { res.redirect(302, this.approver.signInUrl(`/authorize/continue?request=${encodeURIComponent(id)}`)); return }
      res.status(200).type('html').send(this.page(id, client, '', user.email))
      return
    }
    res.status(200).type('html').send(this.page(id, client))
  }

  private page(id: string, client: OAuthClientInformationFull, message = '', signedInAs = ''): string {
    const name = escapeHtml(client.client_name ?? 'An application')
    const host = escapeHtml(new URL(client.redirect_uris[0] ?? 'https://unknown.invalid').host)
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Approve access · voicebrain</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b0b0b;color:#eee;font:14px/1.6 "Red Hat Display","Inter",system-ui,sans-serif}
main{width:min(100%,460px);padding:32px;border:1px solid #262626;border-radius:20px;background:#121212}p.eyebrow{margin:0 0 14px;color:#888;font-size:11px;letter-spacing:.15em;text-transform:uppercase}
h1{margin:0 0 12px;font-size:28px;font-weight:450;letter-spacing:-.05em}p{color:#b5b5b5}strong{color:#eee;font-weight:550}label{display:block;margin-top:22px;color:#b5b5b5;font-size:12px}
input{display:block;width:100%;margin-top:8px;padding:12px;border:1px solid #3a3a3a;border-radius:10px;color:#eee;background:#0b0b0b;font:inherit}input:focus-visible,button:focus-visible{outline:2px solid #d5bea7;outline-offset:2px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:12px;border:0;border-radius:10px;font:inherit;font-size:13px;font-weight:650;cursor:pointer}.go{color:#0b0b0b;background:#eee}.no{color:#b5b5b5;background:#262626}.msg{margin:16px 0 0;color:#e4a6a6}</style></head>
<body><main><p class="eyebrow">voicebrain</p><h1>Approve access</h1>
<p><strong>${name}</strong> (${host}) wants to read your voice notes and wiki, mark tasks done, and write wiki pages. Only approve if you started this from your own assistant.</p>
${message ? `<p class="msg" role="alert">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/authorize/decision"><input type="hidden" name="request" value="${escapeHtml(id)}">
${signedInAs ? `<p>Signed in as <strong>${escapeHtml(signedInAs)}</strong>.</p>` : '<label>Owner passphrase<input name="passphrase" type="password" autocomplete="current-password" autofocus></label>'}
<div class="row"><button class="no" name="decision" value="deny" type="submit" formnovalidate>Deny</button><button class="go" name="decision" value="approve" type="submit">Approve</button></div></form></main></body></html>`
  }

  /** Step 2: the person answered. Check who they are and send the client back with a one-time code. */
  async decide(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, string>
    const row = this.db.prepare('SELECT client_id, json, expires_at FROM oauth_pending WHERE id = ?').get(String(body.request ?? '')) as { client_id: string; json: string; expires_at: number } | undefined
    if (!row || row.expires_at < this.seconds()) { res.status(400).type('text').send('This approval request expired. Start again from your assistant.'); return }
    const client = this.clientsStore.getClient(row.client_id) as OAuthClientInformationFull | undefined
    if (!client) { res.status(400).type('text').send('Unknown client.'); return }
    const params = JSON.parse(row.json) as { state?: string; codeChallenge: string; redirectUri: string; resource?: string }
    const back = (values: Record<string, string>) => {
      const url = new URL(params.redirectUri)
      for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
      if (params.state) url.searchParams.set('state', params.state)
      return url.href
    }
    if (body.decision === 'deny') {
      this.db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(String(body.request))
      res.redirect(302, back({ error: 'access_denied' }))
      return
    }
    let userId = OWNER_ID
    if (this.approver.kind === 'google') {
      // The session cookie is the proof, so refuse anything a foreign page could have submitted for the browser.
      if (!this.approver.originOk(req)) { res.status(403).type('text').send('This request came from another site.'); return }
      const user = this.approver.userOf(req)
      if (!user) { res.redirect(303, this.approver.signInUrl(`/authorize/continue?request=${encodeURIComponent(String(body.request))}`)); return }
      userId = user.id
    } else {
      const key = req.ip ?? 'unknown'
      if (this.throttle.blocked(key)) { res.status(429).type('html').send(this.page(String(body.request), client, 'Too many wrong attempts. Wait ten minutes and try again.')); return }
      if (!this.approver.passphrase || !same(String(body.passphrase ?? ''), this.approver.passphrase)) {
        this.throttle.failed(key)
        res.status(401).type('html').send(this.page(String(body.request), client, 'That passphrase is not right.'))
        return
      }
    }
    this.db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(String(body.request))
    const code = token()
    this.db.prepare('INSERT INTO oauth_codes(hash, client_id, challenge, redirect_uri, resource, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(code), client.client_id, params.codeChallenge, params.redirectUri, params.resource ?? null, userId, this.seconds() + CODE_SECONDS)
    res.redirect(302, back({ code }))
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = this.db.prepare('SELECT challenge, client_id, expires_at, attempted FROM oauth_codes WHERE hash = ?').get(sha(code)) as { challenge: string; client_id: string; expires_at: number; attempted: number } | undefined
    if (!row || row.client_id !== client.client_id || row.expires_at < this.seconds() || row.attempted) {
      // One try only: a code whose PKCE check failed (or was replayed) is burned.
      if (row) this.db.prepare('DELETE FROM oauth_codes WHERE hash = ?').run(sha(code))
      throw new InvalidGrantError('Invalid or expired authorization code')
    }
    this.db.prepare('UPDATE oauth_codes SET attempted = 1 WHERE hash = ?').run(sha(code))
    return row.challenge
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const row = this.db.prepare('SELECT client_id, redirect_uri, resource, user_id, expires_at FROM oauth_codes WHERE hash = ?').get(sha(code)) as { client_id: string; redirect_uri: string; resource: string | null; user_id: string; expires_at: number } | undefined
    this.db.prepare('DELETE FROM oauth_codes WHERE hash = ?').run(sha(code)) // single use, even if the checks below fail
    if (!row || row.client_id !== client.client_id || row.expires_at < this.seconds()) throw new InvalidGrantError('Invalid or expired authorization code')
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request')
    if (!this.isActive(row.user_id)) throw new InvalidGrantError('This account no longer has access')
    return this.issue(client.client_id, row.resource, row.user_id)
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const row = this.db.prepare("SELECT client_id, resource, user_id, expires_at FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'").get(sha(refreshToken)) as { client_id: string; resource: string | null; user_id: string; expires_at: number } | undefined
    if (!row || row.client_id !== client.client_id || row.expires_at < this.seconds()) throw new InvalidGrantError('Invalid or expired refresh token')
    this.db.prepare('DELETE FROM oauth_tokens WHERE hash = ?').run(sha(refreshToken)) // rotate
    if (!this.isActive(row.user_id)) throw new InvalidGrantError('This account no longer has access')
    return this.issue(client.client_id, row.resource, row.user_id)
  }

  private issue(clientId: string, resource: string | null, userId: string): OAuthTokens {
    this.sweep()
    const access = token()
    const refresh = token()
    const at = this.seconds()
    const insert = this.db.prepare('INSERT INTO oauth_tokens(hash, kind, client_id, resource, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    insert.run(sha(access), 'access', clientId, resource, userId, at + ACCESS_SECONDS)
    insert.run(sha(refresh), 'refresh', clientId, resource, userId, at + REFRESH_SECONDS)
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: SCOPE }
  }

  async verifyAccessToken(value: string): Promise<AuthInfo> {
    if (this.staticToken && same(value, this.staticToken)) return { token: value, clientId: 'static-token', scopes: [SCOPE], expiresAt: this.seconds() + ACCESS_SECONDS, extra: { userId: OWNER_ID } }
    const row = this.db.prepare("SELECT client_id, resource, user_id, expires_at FROM oauth_tokens WHERE hash = ? AND kind = 'access'").get(sha(value)) as { client_id: string; resource: string | null; user_id: string; expires_at: number } | undefined
    if (!row || row.expires_at < this.seconds() || !this.isActive(row.user_id)) throw new InvalidTokenError('Invalid or expired token')
    return { token: value, clientId: row.client_id, scopes: [SCOPE], expiresAt: row.expires_at, extra: { userId: row.user_id }, ...(row.resource ? { resource: new URL(row.resource) } : {}) }
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db.prepare('DELETE FROM oauth_tokens WHERE hash = ?').run(sha(request.token))
  }
}

/** Token check for when only a static MCP_TOKEN is configured (no OAuth). */
export function staticTokenVerifier(secret: string) {
  return {
    async verifyAccessToken(value: string): Promise<AuthInfo> {
      if (!secret || !same(value, secret)) throw new InvalidTokenError('Invalid token')
      return { token: value, clientId: 'static-token', scopes: [SCOPE], expiresAt: Math.floor(Date.now() / 1000) + ACCESS_SECONDS, extra: { userId: OWNER_ID } }
    },
  }
}
