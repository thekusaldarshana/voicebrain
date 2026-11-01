import type { Digest, NoteEdits, NoteMeta, NoteState, Transcript } from './types.ts'
import { OWNER_ID, payloadBytes, type NoteStorage, type StoredStream } from './storage.ts'

const text = new TextDecoder()
const encodeJson = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

/**
 * One person's notes, typed. The bytes live in a `NoteStorage` (local files today, Google Drive next); this
 * class adds what is the same for every backend: JSON in and out, the state default, and the user id.
 *
 * Per note (see storage.ts for which of these are source of truth):
 *   meta.json  audio.<ext>  transcript.json  digest.json  edits.json  state.json
 */
export class Store {
  readonly storage: NoteStorage
  readonly userId: string

  constructor(storage: NoteStorage, userId: string = OWNER_ID) {
    this.storage = storage
    this.userId = userId
  }

  has(id: string): Promise<boolean> { return this.storage.hasNote(this.userId, id) }

  /** Ids of real notes. A folder without meta.json (a half-written or half-deleted note) does not count. */
  ids(): Promise<string[]> { return this.storage.listNotes(this.userId) }

  /** Missing and unreadable JSON both read as null: the caller then does the work again. */
  private async json<T>(id: string, file: string): Promise<T | null> {
    const bytes = await this.storage.get(this.userId, id, file)
    if (!bytes) return null
    try { return JSON.parse(text.decode(bytes)) as T } catch { return null }
  }

  meta(id: string) { return this.json<NoteMeta>(id, 'meta.json') }
  transcript(id: string) { return this.json<Transcript>(id, 'transcript.json') }
  digest(id: string) { return this.json<Digest>(id, 'digest.json') }
  async state(id: string): Promise<NoteState> {
    return (await this.json<NoteState>(id, 'state.json')) ?? { attempts: 0, nextAttemptAt: null, lastError: null, failed: false, stage: null }
  }
  edits(id: string) { return this.json<NoteEdits>(id, 'edits.json') }

  /** The storage refuses a write to a note that is gone (NoteGone), so work that finishes after a delete cannot bring a note back. */
  private write(id: string, file: string, value: unknown): Promise<void> { return this.storage.put(this.userId, id, file, encodeJson(value)) }
  writeTranscript(id: string, transcript: Transcript) { return this.write(id, 'transcript.json', transcript) }
  writeDigest(id: string, digest: Digest) { return this.write(id, 'digest.json', digest) }
  writeState(id: string, state: NoteState) { return this.write(id, 'state.json', state) }
  writeEdits(id: string, edits: NoteEdits) { return this.write(id, 'edits.json', edits) }

  /** Removes the audio, the transcript and everything else stored for the note, wherever the backend keeps it. */
  deleteNote(id: string): Promise<void> { return this.storage.deleteNote(this.userId, id) }

  /** The recording as a stream (for playback), or null if the note has none. May be fetched back from the backend. */
  async audio(meta: NoteMeta): Promise<StoredStream | null> {
    return meta.audioFile ? this.storage.getStream(this.userId, meta.id, meta.audioFile) : null
  }

  /** The whole recording in memory (for transcription), or null if there is none. */
  async audioBytes(meta: NoteMeta): Promise<Uint8Array | null> {
    const found = await this.audio(meta)
    return found ? payloadBytes(found.stream) : null
  }

  /** Transcribed and digested: let the backend apply its retainAudio policy. */
  releaseAudio(id: string): Promise<void> { return this.storage.releaseAudio(this.userId, id) }

  /** Stores an upload. The note only exists once complete, so a crash never leaves half a note. Returns false for a repeat. */
  saveUpload(meta: NoteMeta, audio: Uint8Array, extension: string): Promise<boolean> {
    const file = `audio.${extension}`
    return this.storage.createNote(this.userId, meta.id, { meta: encodeJson({ ...meta, audioFile: file, audioBytes: audio.byteLength }), files: { [file]: audio } })
  }

  /** A note typed or dictated in chat. No audio, and the "transcript" is the text itself. */
  async saveTextNote(meta: NoteMeta, body: string): Promise<void> {
    const transcript: Transcript = { text: body, language: null, durationSec: null, model: 'text', segments: [], suspectedSilence: false, createdAt: meta.receivedAt }
    if (!(await this.storage.createNote(this.userId, meta.id, { meta: encodeJson(meta), files: { 'transcript.json': encodeJson(transcript) } }))) throw new Error('a note with this id already exists')
  }
}
