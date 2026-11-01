import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The identity behind the static tokens (INGEST_TOKEN, MCP_TOKEN), the legacy passphrase, and every token
 * that was issued before sign-in existed. It is not a person in the users table.
 */
export const OWNER_ID = 'owner'

export interface User { id: string; email: string; name: string; createdAt: string }
export interface Profile { sub: string; email: string; name: string }
export type SignIn = { ok: true; user: User; claimed: boolean } | { ok: false; reason: 'not-allowed' | 'instance-claimed' }

const SESSION_MS = 14 * 86_400_000
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Who is allowed in, and who is signed in. A user's id is their Google `sub`, which never changes (an email can).
 *
 * Access rule: with ALLOWED_EMAILS set, only those addresses may sign in. With it unset, the first person to sign
 * in claims the instance and nobody else is let in. The claim is one SQL transaction, so two people signing in at
 * the same moment cannot both win. Browser sessions are stored as SHA-256 hashes, like every other token here.
 */
export class Users {
  private readonly db: DatabaseSync
  private readonly allowed: Set<string>
  private readonly now: () => number

  constructor(path: string, options: { allowedEmails?: string[]; now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.allowed = new Set((options.allowedEmails ?? []).map(email => email.toLowerCase()))
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `)
  }

  close() { this.db.close() }

  /** True when an allowlist is set. Otherwise the first user claims the instance. */
  get hasAllowlist(): boolean { return this.allowed.size > 0 }

  /** The sign-in decision. Creates (or refreshes) the user when they are allowed. */
  signIn(profile: Profile): SignIn {
    const createdAt = new Date(this.now()).toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(profile.sub)
      let claimed = false
      if (this.hasAllowlist) {
        if (!this.allowed.has(profile.email.toLowerCase())) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'not-allowed' } }
      } else if (!existing) {
        const taken = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
        if (taken.n > 0) { this.db.exec('ROLLBACK'); return { ok: false, reason: 'instance-claimed' } }
        claimed = true
      }
      if (existing) this.db.prepare('UPDATE users SET email = ?, name = ? WHERE id = ?').run(profile.email, profile.name, profile.sub)
      else this.db.prepare('INSERT INTO users(id, email, name, created_at) VALUES (?, ?, ?, ?)').run(profile.sub, profile.email, profile.name, createdAt)
      this.db.exec('COMMIT')
      return { ok: true, user: this.find(profile.sub) as User, claimed }
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  find(id: string): User | null {
    const row = this.db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(id) as { id: string; email: string; name: string; created_at: string } | undefined
    return row ? { id: row.id, email: row.email, name: row.name, createdAt: row.created_at } : null
  }

  /**
   * Whether a token or session belonging to this user may still be used. Taking someone off ALLOWED_EMAILS cuts
   * off their sessions, devices and assistant tokens at once. The owner identity (static tokens) is always active.
   */
  isActive(id: string): boolean {
    if (id === OWNER_ID) return true
    const user = this.find(id)
    return Boolean(user) && (!this.hasAllowlist || this.allowed.has((user as User).email.toLowerCase()))
  }

  /** Everyone who has signed in, whether or not they are still allowed. */
  all(): User[] {
    return (this.db.prepare('SELECT id, email, name, created_at FROM users ORDER BY created_at').all() as Array<{ id: string; email: string; name: string; created_at: string }>).map(row => ({ id: row.id, email: row.email, name: row.name, createdAt: row.created_at }))
  }

  createSession(userId: string): { token: string; expiresAt: number } {
    const at = this.now()
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(at)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = at + SESSION_MS
    this.db.prepare('INSERT INTO sessions(hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, expiresAt)
    return { token, expiresAt }
  }

  userForSession(token: string): User | null {
    if (!token) return null
    const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE hash = ?').get(sha(token)) as { user_id: string; expires_at: number } | undefined
    if (!row || row.expires_at < this.now() || !this.isActive(row.user_id)) return null
    return this.find(row.user_id)
  }

  endSession(token: string) { if (token) this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha(token)) }
}
