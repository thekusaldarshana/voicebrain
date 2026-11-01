import { UUID } from './util.ts'

/**
 * The storage seam. Everything that must survive (the "source of truth") goes through `NoteStorage`;
 * everything that can be rebuilt from it (vault pages, the search index, tasks.md) stays local and
 * disposable. A backend only has to store named byte blobs per note, so a Google Drive backend is
 * a matter of mapping (userId, noteId, filename) to Drive files.
 *
 * Source of truth, per note (`<filename>`):
 *   meta.json        what the app sent (immutable). A note EXISTS if and only if its meta.json does.
 *   audio.<ext>      the recording (immutable, may be large; streamed, never required in memory)
 *   transcript.json  the raw words
 *   digest.json      model extraction (regenerable, but kept: it costs money to redo)
 *   edits.json       later edits to title and tags
 * Operational, not source of truth:
 *   state.json       retry bookkeeping. A backend MAY keep it outside durable storage (a local sidecar is
 *                    fine) as long as it behaves like any other file here: `put`/`get`/`list`, and gone
 *                    after `deleteNote`. Losing it only resets retry counters.
 */

/** Today there is one person. Every call still carries a user id, so many users is a data change, not a rewrite. */
export const OWNER_ID = 'owner'

/**
 * What a backend does with its local copy of the audio once a note has been transcribed and digested:
 *   keep               leave it where it is.
 *   drop-after-digest  evict the local working copy. The audio is NOT lost: `getStream` fetches it back from
 *                      the backend's durable store on demand (playback, re-transcription). A backend whose
 *                      only copy is local (LocalStorage) cannot honor this and refuses it at construction.
 */
export type RetainAudio = 'keep' | 'drop-after-digest'

/** What goes in: whole bytes, or a stream (audio). */
export type Payload = Uint8Array | ReadableStream<Uint8Array>

/** What comes out for audio. `size` is null when the backend cannot tell without reading. */
export interface StoredStream { stream: ReadableStream<Uint8Array>; size: number | null }

/** A new note. `meta` is written last, so the note appears complete or not at all. */
export interface NewNote {
  meta: Uint8Array
  /** Other files that exist from the first moment: `audio.<ext>`, or `transcript.json` for a text note. */
  files?: Record<string, Payload>
}

export interface NoteStorage {
  /** The effective policy for the audio's local copy. */
  readonly retainAudio: RetainAudio

  /** Ids of real notes (those with a meta.json), sorted. A half-written or half-deleted note does not count. */
  listNotes(userId: string): Promise<string[]>
  hasNote(userId: string, noteId: string): Promise<boolean>

  /**
   * Creates a note atomically: its files and meta.json appear together or not at all, never a partial note.
   * Resolves false (and changes nothing) if the note already exists, which makes uploads idempotent.
   * `note.files` must not contain meta.json.
   */
  createNote(userId: string, noteId: string, note: NewNote): Promise<boolean>

  /** Logical filenames of the note (no temporary or internal files), sorted. Empty if there is no such note. */
  list(userId: string, noteId: string): Promise<string[]>

  /** The file's bytes, or null if the note or file does not exist. */
  get(userId: string, noteId: string, filename: string): Promise<Uint8Array | null>

  /**
   * Replaces (or adds) one file. Readers see the old content or the new, never a mixture or a partial file.
   * Throws NoteGone if the note does not exist, including when it is deleted while this write is in flight:
   * a write that finishes after a delete must not bring the note, or any trace of it, back.
   */
  put(userId: string, noteId: string, filename: string, data: Payload): Promise<void>

  /** The file as a stream (audio), or null if missing. May fetch it back from the backend's durable store. */
  getStream(userId: string, noteId: string, filename: string): Promise<StoredStream | null>

  /** Removes the note and every file of it, including local copies and caches. Idempotent. No trace remains. */
  deleteNote(userId: string, noteId: string): Promise<void>

  /**
   * The pipeline is finished with this note's audio (transcribed and digested). Applies `retainAudio`:
   * under drop-after-digest the local copy is evicted. Never deletes the durable copy, never fails for a
   * note that is gone. A no-op under `keep`.
   */
  releaseAudio(userId: string, noteId: string): Promise<void>
}

const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** Backends call these on every method. Ids and names end up in paths and URLs, so they are strictly shaped. */
export function checkUser(userId: string): string {
  if (!USER_ID.test(userId)) throw new Error('bad user id')
  return userId
}

export function checkNote(noteId: string): string {
  if (!UUID.test(noteId)) throw new Error('bad note id')
  return noteId
}

/** Letters, digits, `.`, `_`, `-`; no slashes, no leading dot, no `..`, and `.tmp` is reserved for backends' own temporaries. */
export function checkFile(filename: string): string {
  if (!FILE_NAME.test(filename) || filename.includes('..') || filename.endsWith('.tmp')) throw new Error('bad file name')
  return filename
}

export const isAudioFile = (filename: string) => filename.startsWith('audio.')

/** Reads a stream to the end. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) { chunks.push(chunk); total += chunk.byteLength }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return out
}

export const payloadBytes = (data: Payload): Promise<Uint8Array> => (data instanceof Uint8Array ? Promise.resolve(data) : readAll(data))
