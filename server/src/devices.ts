import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface Device { id: string; name: string; createdAt: string; lastSeenAt: string | null }

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * One token per phone or computer, so a lost phone can be cut off without touching the others.
 * Tokens are stored only as SHA-256 hashes; the plain token exists once, when the device is approved.
 */
export class Devices {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_agent TEXT, created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
    `)
  }

  close() { this.db.close() }

  create(name: string, userAgent: string): { device: Device; token: string } {
    const token = `vbd_${randomBytes(32).toString('base64url')}`
    const device: Device = { id: randomUUID(), name: name.slice(0, 40) || 'Device', createdAt: new Date(this.now()).toISOString(), lastSeenAt: null }
    this.db.prepare('INSERT INTO devices(id, name, token_hash, user_agent, created_at) VALUES (?, ?, ?, ?, ?)').run(device.id, device.name, sha(token), userAgent.slice(0, 200), device.createdAt)
    return { device, token }
  }

  /** The device this token belongs to, or null if it is unknown or revoked. "Last seen" is recorded at most once a minute. */
  verify(token: string): Device | null {
    if (!token.startsWith('vbd_')) return null
    const row = this.db.prepare('SELECT id, name, created_at, last_seen_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha(token)) as { id: string; name: string; created_at: string; last_seen_at: string | null } | undefined
    if (!row) return null
    if (!row.last_seen_at || this.now() - Date.parse(row.last_seen_at) > 60_000) {
      row.last_seen_at = new Date(this.now()).toISOString()
      this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(row.last_seen_at, row.id)
    }
    return { id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at }
  }

  list(): Device[] {
    return (this.db.prepare('SELECT id, name, created_at, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at').all() as Array<{ id: string; name: string; created_at: string; last_seen_at: string | null }>)
      .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at }))
  }

  revoke(id: string): boolean {
    return Number(this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date(this.now()).toISOString(), id).changes) > 0
  }
}
