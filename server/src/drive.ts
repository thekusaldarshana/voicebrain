import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DriveNotConnected, type DriveTokenProvider } from './drive-tokens.ts'
import type { DriveGrant, GoogleEndpoints } from './google.ts'
import { GOOGLE } from './google.ts'

const VERSION = 'v1'
const EARLY_MS = 60_000
const clean = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').trim().slice(0, max) : '')

/**
 * AES-256-GCM for the stored Drive refresh tokens. Each token gets its own random 96-bit nonce, and the user id is the
 * associated data: a stored token only opens for the user it was sealed for, so a row copied to another user's id
 * (by a bug or by someone with the database file) is refused, as is any changed byte. The key is never stored.
 */
export class TokenCipher {
  private readonly key: Buffer

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64')
    if (this.key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes in base64.')
  }

  seal(plain: string, userId: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 })
    cipher.setAAD(Buffer.from(userId, 'utf8'))
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return [VERSION, iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
  }

  /** Throws if the value was changed, belongs to another user, or was sealed with another key. */
  open(sealed: string, userId: string): string {
    const [version, iv, body, tag, extra] = sealed.split('.')
    if (version !== VERSION || !iv || !body || !tag || extra !== undefined) throw new Error('unreadable token')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'), { authTagLength: 16 })
    decipher.setAAD(Buffer.from(userId, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  }
}

export interface DriveAccountsOptions {
  path: string
  cipher: TokenCipher
  clientId: string
  clientSecret: string
  endpoints?: GoogleEndpoints
  /** Whether this user may still use the server. When not, their Drive is left alone but unusable. */
  isActive?: (userId: string) => boolean
  now?: () => number
}

interface Cached { token: string; expiresAt: number }

/**
 * Each person's Drive connection. The refresh token lives encrypted in a table; access tokens live only in memory and
 * are renewed shortly before they expire. Many callers asking at once share one renewal. If Google says the grant is
 * gone (the person revoked it, or it expired) the stored token is deleted and the caller is told the Drive is not
 * connected, so the app can ask the person to connect again.
 */
export class DriveAccounts implements DriveTokenProvider {
  private readonly db: DatabaseSync
  private readonly options: DriveAccountsOptions
  private readonly endpoints: GoogleEndpoints
  private readonly now: () => number
  private readonly access = new Map<string, Cached>()
  private readonly refreshing = new Map<string, Promise<string>>()
  private readonly epoch = new Map<string, number>()

  constructor(options: DriveAccountsOptions) {
    this.options = options
    this.endpoints = options.endpoints ?? GOOGLE
    this.now = options.now ?? Date.now
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
    this.db = new DatabaseSync(options.path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS drive_tokens(user_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, connected_at TEXT NOT NULL);
    `)
  }

  close() { this.db.close() }

  private bump(userId: string) { this.epoch.set(userId, (this.epoch.get(userId) ?? 0) + 1) }

  /** Whether a token is stored. Does not ask Google, so a revoked grant shows as connected until it is next used. */
  isConnected(userId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM drive_tokens WHERE user_id = ?').get(userId))
  }

  /** Stores (or replaces) the person's connection after a successful consent. */
  save(userId: string, grant: DriveGrant) {
    this.bump(userId)
    this.refreshing.delete(userId)
    this.db.prepare('INSERT INTO drive_tokens(user_id, sealed, connected_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET sealed = excluded.sealed, connected_at = excluded.connected_at')
      .run(userId, this.options.cipher.seal(grant.refreshToken, userId), new Date(this.now()).toISOString())
    this.access.set(userId, { token: grant.accessToken, expiresAt: this.now() + grant.expiresIn * 1000 })
  }

  async accessToken(userId: string): Promise<string> {
    if (this.options.isActive && !this.options.isActive(userId)) throw new DriveNotConnected('This account no longer has access.')
    const cached = this.access.get(userId)
    if (cached && cached.expiresAt - EARLY_MS > this.now()) return cached.token
    const running = this.refreshing.get(userId)
    if (running) return running
    const started = this.refresh(userId).finally(() => { if (this.refreshing.get(userId) === started) this.refreshing.delete(userId) })
    this.refreshing.set(userId, started)
    return started
  }

  private async refresh(userId: string): Promise<string> {
    const row = this.db.prepare('SELECT sealed FROM drive_tokens WHERE user_id = ?').get(userId) as { sealed: string } | undefined
    if (!row) throw new DriveNotConnected('Google Drive is not connected.')
    let refreshToken: string
    try { refreshToken = this.options.cipher.open(row.sealed, userId) } catch {
      // Wrong key, or a row that was changed or moved. Do not delete: with the right key it would still work.
      console.error('a stored Drive token could not be decrypted (wrong TOKEN_ENCRYPTION_KEY, or the row was altered)')
      throw new DriveNotConnected('The stored Google Drive connection cannot be read. Connect Drive again.')
    }
    const epoch = this.epoch.get(userId) ?? 0
    let response: Response
    try {
      response = await fetch(this.endpoints.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.options.clientId, client_secret: this.options.clientSecret }),
      })
    } catch { throw new Error('Could not reach Google to renew Drive access.') }
    const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; error?: unknown } | null
    if (!response.ok || typeof body?.access_token !== 'string') {
      if (body?.error === 'invalid_grant') {
        // Revoked, or expired (a consent screen in Testing mode expires refresh tokens after 7 days). It will never work again.
        if ((this.epoch.get(userId) ?? 0) === epoch) {
          this.db.prepare('DELETE FROM drive_tokens WHERE user_id = ? AND sealed = ?').run(userId, row.sealed)
          this.access.delete(userId)
        }
        throw new DriveNotConnected('Google Drive access was revoked or has expired. Connect Drive again.')
      }
      console.error(`google drive token refresh failed (${response.status}${typeof body?.error === 'string' ? `, ${clean(body.error, 40)}` : ''})`)
      throw new Error('Google would not renew Drive access just now.')
    }
    if ((this.epoch.get(userId) ?? 0) === epoch) {
      const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
      this.access.set(userId, { token: body.access_token, expiresAt: this.now() + seconds * 1000 })
      if (typeof body.refresh_token === 'string' && body.refresh_token && body.refresh_token !== refreshToken) {
        this.db.prepare('UPDATE drive_tokens SET sealed = ? WHERE user_id = ?').run(this.options.cipher.seal(body.refresh_token, userId), userId) // Google rotated it
      }
    }
    return body.access_token
  }

  /** Disconnects: tells Google to revoke the grant (best effort), then forgets it. Returns whether anything was connected. */
  async disconnect(userId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT sealed FROM drive_tokens WHERE user_id = ?').get(userId) as { sealed: string } | undefined
    this.bump(userId)
    this.refreshing.delete(userId)
    this.access.delete(userId)
    this.db.prepare('DELETE FROM drive_tokens WHERE user_id = ?').run(userId)
    if (!row) return false
    try {
      const token = this.options.cipher.open(row.sealed, userId)
      await fetch(this.endpoints.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(5_000) })
    } catch { /* the grant may stay at Google until the person removes it at myaccount.google.com/permissions; we no longer hold it */ }
    return true
  }
}
