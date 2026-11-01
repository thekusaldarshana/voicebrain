import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface AgentKey { id: string; name: string; createdAt: string; lastUsedAt: string | null }

export const KEY_PREFIX = 'vbk_'
const MAX_KEYS_PER_USER = 20
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const cleanName = (name: string) => name.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 60) || 'Unnamed key'

/**
 * Personal access keys for tools that connect to the notes over MCP without a browser sign-in: Claude Code, Cursor,
 * opencode, Codex and the like. A key belongs to one person and can be revoked on its own. Only its SHA-256 is stored, so
 * a copy of the database cannot be used to connect, and the key itself is shown once, when it is made.
 */
export class AgentKeys {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_keys(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS agent_keys_user ON agent_keys(user_id);
    `)
  }

  close() { this.db.close() }

  /** Makes a key. `secret` is the only time it can be read. Refuses when the person already has the maximum. */
  create(userId: string, name: string): { key: AgentKey; secret: string } | null {
    const active = this.db.prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE user_id = ? AND revoked_at IS NULL').get(userId) as { n: number }
    if (active.n >= MAX_KEYS_PER_USER) return null
    const secret = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
    const key: AgentKey = { id: randomUUID(), name: cleanName(name), createdAt: new Date(this.now()).toISOString(), lastUsedAt: null }
    this.db.prepare('INSERT INTO agent_keys(id, user_id, name, hash, created_at) VALUES (?, ?, ?, ?, ?)').run(key.id, userId, key.name, sha(secret), key.createdAt)
    return { key, secret }
  }

  list(userId: string): AgentKey[] {
    return (this.db.prepare('SELECT id, name, created_at, last_used_at FROM agent_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at').all(userId) as Array<{ id: string; name: string; created_at: string; last_used_at: string | null }>)
      .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at }))
  }

  /** Revokes one of this person's keys. Returns false when there is no such active key of theirs. */
  revoke(userId: string, id: string): boolean {
    return Number(this.db.prepare('UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(new Date(this.now()).toISOString(), id, userId).changes) > 0
  }

  /** Whose key this is, or null for anything that is not a live key. Notes the time it was used, at most once a minute. */
  verify(secret: string): { userId: string; id: string } | null {
    if (!secret.startsWith(KEY_PREFIX) || secret.length > 200) return null
    const row = this.db.prepare('SELECT id, user_id, last_used_at FROM agent_keys WHERE hash = ? AND revoked_at IS NULL').get(sha(secret)) as { id: string; user_id: string; last_used_at: string | null } | undefined
    if (!row) return null
    if (!row.last_used_at || this.now() - Date.parse(row.last_used_at) > 60_000) this.db.prepare('UPDATE agent_keys SET last_used_at = ? WHERE id = ?').run(new Date(this.now()).toISOString(), row.id)
    return { userId: row.user_id, id: row.id }
  }
}
