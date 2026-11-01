import { checkFile, checkNote, checkUser, isAudioFile, payloadBytes, type NewNote, type NoteStorage, type Payload, type RetainAudio, type StoredStream } from '../src/storage.ts'
import { NoteGone } from '../src/util.ts'

const tick = () => new Promise<void>(done => setImmediate(done))
const copy = (bytes: Uint8Array) => bytes.slice()
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
  // Two chunks on purpose, so a consumer that only reads the first chunk is caught.
  const middle = Math.ceil(bytes.byteLength / 2)
  return new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, middle)); controller.enqueue(bytes.slice(middle)); controller.close() } })
}

/**
 * A fake backend that behaves like a remote store (Drive-shaped) with a local audio cache:
 * everything lives in `remote`; `cached` is the set of audio files "on local disk". Reading audio that is
 * not cached counts as a remote fetch and caches it again until the next `releaseAudio`.
 */
export class MemoryStorage implements NoteStorage {
  readonly retainAudio: RetainAudio
  /** How many times audio had to be fetched back because it was no longer held locally. */
  remoteFetches = 0
  private readonly remote = new Map<string, Map<string, Uint8Array>>() // `${user}/${note}` -> files
  private readonly cached = new Set<string>() // `${user}/${note}/${filename}`

  constructor(options: { retainAudio?: RetainAudio } = {}) { this.retainAudio = options.retainAudio ?? 'keep' }

  private key(userId: string, noteId: string) { return `${checkUser(userId)}/${checkNote(noteId)}` }
  isCached(userId: string, noteId: string, filename: string) { return this.cached.has(`${this.key(userId, noteId)}/${filename}`) }
  /** Every file held anywhere, for "no trace left" checks. */
  allKeys(): string[] { return [...this.remote.entries()].flatMap(([note, files]) => [...files.keys()].map(name => `${note}/${name}`)).concat([...this.cached]) }

  async listNotes(userId: string): Promise<string[]> {
    await tick()
    const prefix = `${checkUser(userId)}/`
    return [...this.remote.entries()].filter(([key, files]) => key.startsWith(prefix) && files.has('meta.json')).map(([key]) => key.slice(prefix.length)).sort()
  }

  async hasNote(userId: string, noteId: string): Promise<boolean> {
    await tick()
    return Boolean(this.remote.get(this.key(userId, noteId))?.has('meta.json'))
  }

  async createNote(userId: string, noteId: string, note: NewNote): Promise<boolean> {
    const key = this.key(userId, noteId)
    const files = Object.entries(note.files ?? {})
    for (const [name] of files) {
      checkFile(name)
      if (name === 'meta.json') throw new Error('meta.json is passed as `meta`, not in `files`')
    }
    if (this.remote.get(key)?.has('meta.json')) return false
    // Read everything first: a stream that fails midway must leave nothing behind.
    const staged = new Map<string, Uint8Array>()
    for (const [name, data] of files) staged.set(name, copy(await payloadBytes(data)))
    staged.set('meta.json', copy(note.meta))
    await tick()
    if (this.remote.get(key)?.has('meta.json')) return false
    this.remote.set(key, staged)
    for (const name of staged.keys()) if (isAudioFile(name)) this.cached.add(`${key}/${name}`)
    return true
  }

  async list(userId: string, noteId: string): Promise<string[]> {
    await tick()
    return [...(this.remote.get(this.key(userId, noteId))?.keys() ?? [])].sort()
  }

  async get(userId: string, noteId: string, filename: string): Promise<Uint8Array | null> {
    await tick()
    const bytes = this.remote.get(this.key(userId, noteId))?.get(checkFile(filename))
    return bytes ? copy(bytes) : null
  }

  async put(userId: string, noteId: string, filename: string, data: Payload): Promise<void> {
    const key = this.key(userId, noteId)
    checkFile(filename)
    if (!(await this.hasNote(userId, noteId))) throw new NoteGone(noteId)
    const bytes = copy(await payloadBytes(data))
    await tick()
    const files = this.remote.get(key)
    if (!files?.has('meta.json')) throw new NoteGone(noteId) // deleted while the data was arriving
    files.set(filename, bytes)
    if (isAudioFile(filename)) this.cached.add(`${key}/${filename}`)
  }

  async getStream(userId: string, noteId: string, filename: string): Promise<StoredStream | null> {
    await tick()
    const key = this.key(userId, noteId)
    const bytes = this.remote.get(key)?.get(checkFile(filename))
    if (!bytes) return null
    if (isAudioFile(filename) && !this.cached.has(`${key}/${filename}`)) { this.remoteFetches += 1; this.cached.add(`${key}/${filename}`) }
    return { stream: streamOf(copy(bytes)), size: bytes.byteLength }
  }

  async deleteNote(userId: string, noteId: string): Promise<void> {
    await tick()
    const key = this.key(userId, noteId)
    this.remote.delete(key)
    for (const entry of [...this.cached]) if (entry.startsWith(`${key}/`)) this.cached.delete(entry)
  }

  async releaseAudio(userId: string, noteId: string): Promise<void> {
    await tick()
    const key = this.key(userId, noteId)
    if (this.retainAudio !== 'drop-after-digest') return
    for (const entry of [...this.cached]) if (entry.startsWith(`${key}/`)) this.cached.delete(entry)
  }
}
