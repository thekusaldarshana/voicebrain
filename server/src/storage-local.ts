import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline as pump } from 'node:stream/promises'
import { checkFile, checkNote, checkUser, OWNER_ID, type NewNote, type NoteStorage, type Payload, type RetainAudio, type StoredStream } from './storage.ts'
import { NoteGone, UUID } from './util.ts'

const missing = (error: unknown) => { const code = (error as NodeJS.ErrnoException | undefined)?.code; return code === 'ENOENT' || code === 'ENOTDIR' }

async function writeTo(path: string, data: Payload): Promise<void> {
  if (data instanceof Uint8Array) await writeFile(path, data)
  else await pump(Readable.fromWeb(data as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path))
}

/**
 * Notes as plain files, exactly the layout the server has always used:
 *
 *   <dataDir>/inbox/<noteId>/{meta.json, audio.<ext>, transcript.json, digest.json, edits.json, state.json}
 *
 * The owner's notes live in `inbox/`. Any other user id (not used yet) gets `<dataDir>/users/<userId>/inbox/`.
 * The local disk is the only copy, so there is nothing to fetch back and nothing safe to evict:
 * `retainAudio: 'drop-after-digest'` is refused instead of silently destroying recordings.
 */
export class LocalStorage implements NoteStorage {
  readonly retainAudio: RetainAudio = 'keep'
  private readonly dataDir: string

  constructor(dataDir: string, options: { retainAudio?: RetainAudio } = {}) {
    if ((options.retainAudio ?? 'keep') !== 'keep') {
      throw new Error('LocalStorage cannot drop audio after digest: the disk holds the only copy. Use a backend that keeps a durable copy elsewhere.')
    }
    this.dataDir = dataDir
  }

  private root(userId: string): string {
    return checkUser(userId) === OWNER_ID ? join(this.dataDir, 'inbox') : join(this.dataDir, 'users', userId, 'inbox')
  }

  private dir(userId: string, noteId: string): string {
    return join(this.root(userId), checkNote(noteId))
  }

  async hasNote(userId: string, noteId: string): Promise<boolean> {
    try { await stat(join(this.dir(userId, noteId), 'meta.json')); return true } catch (error) {
      if (missing(error)) return false
      throw error
    }
  }

  async listNotes(userId: string): Promise<string[]> {
    const root = this.root(userId)
    let entries: string[]
    try { entries = await readdir(root) } catch (error) { if (missing(error)) return []; throw error }
    // A delete that was interrupted after hiding the note but before removing it: finish it now.
    await Promise.all(entries.filter(name => /^[^.]+\.deleting-/.test(name)).map(name => rm(join(root, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)))
    const names = entries.filter(name => UUID.test(name)).sort()
    const present = await Promise.all(names.map(name => this.hasNote(userId, name)))
    return names.filter((_, index) => present[index])
  }

  async createNote(userId: string, noteId: string, note: NewNote): Promise<boolean> {
    const final = this.dir(userId, noteId)
    const files = Object.entries(note.files ?? {})
    for (const [name] of files) {
      checkFile(name)
      if (name === 'meta.json') throw new Error('meta.json is passed as `meta`, not in `files`')
    }
    if (await this.hasNote(userId, noteId)) return false
    const partial = `${final}.partial-${randomUUID().slice(0, 8)}`
    await mkdir(partial, { recursive: true })
    try {
      for (const [name, data] of files) await writeTo(join(partial, name), data)
      await writeTo(join(partial, 'meta.json'), note.meta) // last: the note exists only once complete
      await rename(partial, final)
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      if (await this.hasNote(userId, noteId)) return false
      throw error
    }
    return true
  }

  async list(userId: string, noteId: string): Promise<string[]> {
    try { return (await readdir(this.dir(userId, noteId))).filter(name => !name.endsWith('.tmp')).sort() } catch (error) {
      if (missing(error)) return []
      throw error
    }
  }

  async get(userId: string, noteId: string, filename: string): Promise<Uint8Array | null> {
    const path = join(this.dir(userId, noteId), checkFile(filename))
    try {
      const buffer = await readFile(path)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) // plain bytes, as the interface promises
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  async put(userId: string, noteId: string, filename: string, data: Payload): Promise<void> {
    const dir = this.dir(userId, noteId)
    const path = join(dir, checkFile(filename))
    if (!(await this.hasNote(userId, noteId))) throw new NoteGone(noteId)
    const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
    // No mkdir: if the note's folder vanished (deleted meanwhile) this must fail, not recreate it.
    try {
      await writeTo(temporary, data)
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true })
      if (missing(error)) throw new NoteGone(noteId)
      throw error
    }
  }

  async getStream(userId: string, noteId: string, filename: string): Promise<StoredStream | null> {
    const path = join(this.dir(userId, noteId), checkFile(filename))
    let handle
    try { handle = await open(path, 'r') } catch (error) {
      if (missing(error)) return null
      throw error
    }
    const size = (await handle.stat()).size
    return { stream: Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>, size }
  }

  async deleteNote(userId: string, noteId: string): Promise<void> {
    const dir = this.dir(userId, noteId)
    // Hiding the folder is one atomic step: from then on the note does not exist, and a write still in
    // flight into it fails instead of recreating it. Removing the files comes after.
    const hidden = `${dir}.deleting-${randomBytes(4).toString('hex')}`
    try { await rename(dir, hidden) } catch (error) {
      if (missing(error)) return
      throw error
    }
    await rm(hidden, { recursive: true, force: true, maxRetries: 3 })
  }

  async releaseAudio(userId: string, noteId: string): Promise<void> {
    checkUser(userId)
    checkNote(noteId) // nothing to evict: the audio on disk is the only copy
  }
}
