import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adoptOwner } from '../src/adopt.ts'
import { Devices } from '../src/devices.ts'
import { LocalStorage } from '../src/storage-local.ts'
import { OWNER_ID, Users } from '../src/users.ts'
import { NOTE_ID, tempDir } from './helpers.ts'

const ALICE = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const exists = (path: string) => stat(path).then(() => true, () => false)

let dir: Awaited<ReturnType<typeof tempDir>>
beforeEach(async () => {
  dir = await tempDir()
  const root = dir.dir
  // What a server that ran before Google sign-in looks like: a note, a vault with a wiki page, an index, a device, an assistant connection.
  await mkdir(join(root, 'inbox', NOTE_ID), { recursive: true })
  await writeFile(join(root, 'inbox', NOTE_ID, 'meta.json'), JSON.stringify({ id: NOTE_ID }))
  await mkdir(join(root, 'vault', 'wiki'), { recursive: true })
  await writeFile(join(root, 'vault', 'wiki', 'me.md'), 'my own page')
  await writeFile(join(root, 'index.sqlite'), 'x')
  const devices = new Devices(join(root, 'devices.sqlite'))
  devices.create('Phone', 'ua', OWNER_ID)
  devices.close()
  const auth = new DatabaseSync(join(root, 'auth.sqlite'))
  auth.exec(`CREATE TABLE oauth_codes(hash TEXT, user_id TEXT NOT NULL DEFAULT 'owner'); CREATE TABLE oauth_tokens(hash TEXT, kind TEXT, user_id TEXT NOT NULL DEFAULT 'owner');
    INSERT INTO oauth_tokens VALUES ('a', 'access', 'owner'), ('r', 'refresh', 'owner');`)
  auth.close()
  const users = new Users(join(root, 'users.sqlite'), { allowedEmails: [ALICE.email] })
  users.signIn(ALICE)
  users.close()
})
afterEach(async () => { await dir.clean() })

const owners = (file: string, sql: string) => { const db = new DatabaseSync(join(dir.dir, file)); const rows = db.prepare(sql).all() as Array<{ user_id: string }>; db.close(); return rows.map(row => row.user_id) }

describe('adoptOwner', () => {
  it('only reports without --apply, and changes nothing', async () => {
    expect(adoptOwner(dir.dir, 'Alice@Example.com', false)).toEqual({ userId: '1001', email: 'alice@example.com', notes: 1, devices: 1, assistantTokens: 1, applied: false })
    expect(await exists(join(dir.dir, 'inbox', NOTE_ID))).toBe(true)
    expect(await exists(join(dir.dir, 'users'))).toBe(false)
    expect(owners('devices.sqlite', 'SELECT user_id FROM devices')).toEqual([OWNER_ID])
  })

  it('moves the notes and the vault to the person, drops the index, and re-links devices and assistant connections', async () => {
    const result = adoptOwner(dir.dir, ALICE.email, true)
    expect(result).toMatchObject({ applied: true, notes: 1, devices: 1, assistantTokens: 1 })
    expect(await new LocalStorage(dir.dir).listNotes('1001')).toEqual([NOTE_ID])
    expect(await new LocalStorage(dir.dir).listNotes(OWNER_ID)).toEqual([])
    expect(await readFile(join(dir.dir, 'users', '1001', 'vault', 'wiki', 'me.md'), 'utf8')).toBe('my own page')
    expect(await exists(join(dir.dir, 'vault'))).toBe(false)
    expect(await exists(join(dir.dir, 'index.sqlite'))).toBe(false)
    expect(owners('devices.sqlite', 'SELECT user_id FROM devices')).toEqual(['1001'])
    expect(owners('auth.sqlite', 'SELECT user_id FROM oauth_tokens')).toEqual(['1001', '1001'])
    expect(owners('auth.sqlite', 'SELECT user_id FROM oauth_codes')).toEqual([])
  })

  it('sets aside the empty vault and index the server made for the person, instead of refusing', async () => {
    await mkdir(join(dir.dir, 'users', '1001', 'vault', 'wiki'), { recursive: true })
    await writeFile(join(dir.dir, 'users', '1001', 'vault', 'wiki', 'index.md'), 'starter')
    await writeFile(join(dir.dir, 'users', '1001', 'index.sqlite'), 'empty index')
    adoptOwner(dir.dir, ALICE.email, true)
    expect(await readFile(join(dir.dir, 'users', '1001', 'vault', 'wiki', 'me.md'), 'utf8')).toBe('my own page')
    expect(await exists(join(dir.dir, 'users', '1001', 'index.sqlite'))).toBe(false)
    const { readdir } = await import('node:fs/promises')
    const aside = (await readdir(join(dir.dir, 'users', '1001'))).find(name => name.startsWith('vault.unused-'))
    expect(aside).toBeTruthy()
    expect(await readFile(join(dir.dir, 'users', '1001', aside as string, 'wiki', 'index.md'), 'utf8')).toBe('starter')
  })

  it('refuses to merge into a person who already has notes, and leaves everything where it was', async () => {
    await mkdir(join(dir.dir, 'users', '1001', 'inbox', '44444444-4444-4444-8444-444444444444'), { recursive: true })
    expect(() => adoptOwner(dir.dir, ALICE.email, true)).toThrow(/already has notes of their own/)
    expect(await exists(join(dir.dir, 'inbox', NOTE_ID))).toBe(true)
    expect(owners('devices.sqlite', 'SELECT user_id FROM devices')).toEqual([OWNER_ID])
  })

  it('says so when that person has not signed in, or nobody has', async () => {
    expect(() => adoptOwner(dir.dir, 'bob@example.com', true)).toThrow(/has not signed in/)
    const empty = await tempDir()
    try { expect(() => adoptOwner(empty.dir, ALICE.email, true)).toThrow(/Nobody has signed in/) } finally { await empty.clean() }
  })

  it('works on a server that has nothing to move', async () => {
    adoptOwner(dir.dir, ALICE.email, true)
    expect(adoptOwner(dir.dir, ALICE.email, true)).toMatchObject({ notes: 0, devices: 0, assistantTokens: 0 })
  })
})
