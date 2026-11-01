import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OWNER_ID } from './users.ts'

export interface AdoptResult { userId: string; email: string; notes: number; devices: number; assistantTokens: number; applied: boolean }

const count = (db: DatabaseSync, sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n
const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
const notEmpty = (dir: string) => { try { return readdirSync(dir).length > 0 } catch { return false } }

/**
 * Hands everything the owner identity has (notes recorded before Google sign-in, the vault with its wiki pages, the
 * devices and assistant connections made before the switch) to one signed-in person. Run it with the server stopped.
 * Without `apply` it only says what it would do. It refuses to touch a person who already has notes, so it can never
 * merge or overwrite, and it moves folders rather than copying them, so nothing is duplicated.
 *
 * Local storage only: with STORAGE_BACKEND=drive the owner's notes are on this disk and the person's are in their
 * Drive, so moving them is a copy between backends, not a rename.
 */
export function adoptOwner(dataDir: string, email: string, apply: boolean): AdoptResult {
  const wanted = email.trim().toLowerCase()
  if (!existsSync(join(dataDir, 'users.sqlite'))) throw new Error('Nobody has signed in with Google yet (there is no users.sqlite). Sign in first, then run this.')
  const users = new DatabaseSync(join(dataDir, 'users.sqlite'))
  let user: { id: string; email: string } | undefined
  try { user = users.prepare('SELECT id, email FROM users WHERE lower(email) = ?').get(wanted) as typeof user } finally { users.close() }
  if (!user) throw new Error(`${email} has not signed in to this server yet. Sign in once with that Google account, then run this.`)
  if (user.id === OWNER_ID) throw new Error('That user is the owner identity already.')

  const target = join(dataDir, 'users', user.id)
  const inbox = join(dataDir, 'inbox')
  const notes = notEmpty(inbox) ? readdirSync(inbox).filter(name => !name.includes('.')).length : 0
  // Only a problem when there is something to move: running it again after it finished is harmless.
  if ((notes > 0 || existsSync(join(dataDir, 'vault'))) && (notEmpty(join(target, 'inbox')) || existsSync(join(target, 'vault')))) throw new Error(`${user.email} already has notes or a vault of their own. Refusing to merge into them.`)
  let devices = 0
  let assistantTokens = 0
  const open = (name: string) => (existsSync(join(dataDir, name)) ? new DatabaseSync(join(dataDir, name)) : null)
  const deviceDb = open('devices.sqlite')
  const authDb = open('auth.sqlite')
  try {
    if (deviceDb && hasTable(deviceDb, 'devices')) devices = count(deviceDb, 'SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL', OWNER_ID)
    if (authDb && hasTable(authDb, 'oauth_tokens')) assistantTokens = count(authDb, "SELECT COUNT(*) AS n FROM oauth_tokens WHERE user_id = ? AND kind = 'refresh'", OWNER_ID)
    if (apply) {
      // Folders first: if one fails nothing else has changed, and running it again picks up where it stopped.
      mkdirSync(target, { recursive: true })
      if (existsSync(inbox)) renameSync(inbox, join(target, 'inbox'))
      if (existsSync(join(dataDir, 'vault'))) renameSync(join(dataDir, 'vault'), join(target, 'vault'))
      // The search index is rebuilt from the notes when the server starts.
      for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `index.sqlite${suffix}`), { force: true })
      deviceDb?.prepare('UPDATE devices SET user_id = ? WHERE user_id = ?').run(user.id, OWNER_ID)
      for (const table of ['oauth_codes', 'oauth_tokens']) if (authDb && hasTable(authDb, table)) authDb.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(user.id, OWNER_ID)
    }
  } finally { deviceDb?.close(); authDb?.close() }
  return { userId: user.id, email: user.email, notes, devices, assistantTokens, applied: apply }
}
