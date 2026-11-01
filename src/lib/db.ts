import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Note } from './types'

/** Store names and key paths are mirrored by public/sw.js. Change them in both places. */
interface VoiceDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { 'by-created': number } }
  audio: { key: string; value: { id: string; blob: Blob } }
  chunks: { key: [string, number]; value: { noteId: string; seq: number; blob: Blob } }
  kv: { key: string; value: unknown }
}

export const DB_NAME = 'trapper-voice' // an internal name, kept so notes already on a phone stay where they are
let opened: Promise<IDBPDatabase<VoiceDB>> | null = null

export function db(): Promise<IDBPDatabase<VoiceDB>> {
  opened ??= openDB<VoiceDB>(DB_NAME, 1, {
    upgrade(database) {
      const notes = database.createObjectStore('notes', { keyPath: 'id' })
      notes.createIndex('by-created', 'createdAt')
      database.createObjectStore('audio', { keyPath: 'id' })
      database.createObjectStore('chunks', { keyPath: ['noteId', 'seq'] })
      database.createObjectStore('kv')
    },
    blocking() { void opened?.then(database => database.close()); opened = null },
    terminated() { opened = null },
  })
  return opened
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key)
}

export async function putNote(note: Note): Promise<void> {
  await (await db()).put('notes', note)
}

export async function getNote(id: string): Promise<Note | undefined> {
  return (await db()).get('notes', id)
}

export async function listNotes(): Promise<Note[]> {
  const notes = await (await db()).getAllFromIndex('notes', 'by-created')
  return notes.reverse()
}

/** Atomic read-modify-write, safe when the page and the service worker touch the same note. */
export async function updateNote(id: string, patch: Partial<Note>): Promise<Note | undefined> {
  const database = await db()
  const tx = database.transaction('notes', 'readwrite')
  const current = await tx.store.get(id)
  if (!current) { await tx.done; return undefined }
  const next = { ...current, ...patch }
  await tx.store.put(next)
  await tx.done
  return next
}

export async function saveAudio(id: string, blob: Blob): Promise<void> {
  await (await db()).put('audio', { id, blob })
}

export async function getAudio(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('audio', id))?.blob
}

export async function removeAudio(id: string): Promise<void> {
  await (await db()).delete('audio', id)
}

export async function addChunk(noteId: string, seq: number, blob: Blob): Promise<void> {
  await (await db()).put('chunks', { noteId, seq, blob })
}

export async function readChunks(noteId: string): Promise<Blob[]> {
  const rows = await (await db()).getAll('chunks', IDBKeyRange.bound([noteId, 0], [noteId, Number.MAX_SAFE_INTEGER]))
  return rows.sort((a, b) => a.seq - b.seq).map(row => row.blob)
}

export async function clearChunks(noteId: string): Promise<void> {
  await (await db()).delete('chunks', IDBKeyRange.bound([noteId, 0], [noteId, Number.MAX_SAFE_INTEGER]))
}

export async function deleteNoteCompletely(id: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['notes', 'audio', 'chunks'], 'readwrite')
  await Promise.all([
    tx.objectStore('notes').delete(id),
    tx.objectStore('audio').delete(id),
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
    tx.done,
  ])
}
