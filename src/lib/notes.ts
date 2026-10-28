import { deleteNoteCompletely, getAudio, getNote, listNotes, putNote, removeAudio, saveAudio, updateNote } from './db'
import { notifyChanged } from './changes'
import { extensionFor } from './mime'
import type { Note } from './types'

export function newNote(patch: Partial<Note> = {}): Note {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    durationMs: 0,
    mime: '',
    size: 0,
    title: '',
    tags: [],
    marks: [],
    status: 'local',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    uploadedAt: null,
    recovered: false,
    source: 'record',
    audioRemoved: false,
    ...patch,
  }
}

export async function renameNote(id: string, title: string): Promise<void> {
  await updateNote(id, { title: title.trim().slice(0, 140) })
  notifyChanged()
}

export async function setNoteTags(id: string, tags: string[]): Promise<void> {
  await updateNote(id, { tags })
  notifyChanged()
}

/** Metadata edited after upload only changes this device's copy. The server keeps what it received. */
export async function removeNote(id: string): Promise<void> {
  await deleteNoteCompletely(id)
  notifyChanged()
}

/** Failed notes go back in the queue, for example after the token or address was fixed. */
export async function retryFailed(): Promise<number> {
  let count = 0
  for (const note of await listNotes()) {
    if (note.status === 'failed') {
      await updateNote(note.id, { status: 'local', nextAttemptAt: null, attempts: 0 })
      count += 1
    }
  }
  if (count) notifyChanged()
  return count
}

export async function retryNote(id: string): Promise<void> {
  await updateNote(id, { status: 'local', nextAttemptAt: null, attempts: 0, lastError: null })
  notifyChanged()
}

/** Removes uploaded audio from this device once it is older than `keepDays`. -1 keeps everything. */
export async function purgeUploadedAudio(keepDays: number, now = Date.now()): Promise<number> {
  if (keepDays < 0) return 0
  let count = 0
  for (const note of await listNotes()) {
    if (note.status !== 'uploaded' || note.audioRemoved || note.uploadedAt === null) continue
    if (now - note.uploadedAt >= keepDays * 86_400_000) {
      await removeAudio(note.id)
      await updateNote(note.id, { audioRemoved: true })
      count += 1
    }
  }
  if (count) notifyChanged()
  return count
}

export async function audioDuration(file: Blob): Promise<number> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    const finish = (ms: number) => { URL.revokeObjectURL(url); resolve(ms) }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0)
    audio.onerror = () => finish(0)
    audio.src = url
  })
}

/** Adds an existing audio file (for example an older phone recording) to the same upload queue. */
export async function importAudioFile(file: File): Promise<Note> {
  const durationMs = await audioDuration(file)
  const note = newNote({
    createdAt: file.lastModified || Date.now(),
    durationMs,
    mime: file.type || 'audio/mpeg',
    size: file.size,
    title: file.name.replace(/\.[^.]+$/, '').slice(0, 140),
    source: 'import',
  })
  await saveAudio(note.id, file)
  await putNote(note)
  notifyChanged()
  return note
}

export async function downloadNote(id: string): Promise<void> {
  const [note, blob] = await Promise.all([getNote(id), getAudio(id)])
  if (!note || !blob) return
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = new Date(note.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
  link.href = url
  link.download = `voice-note-${stamp}.${extensionFor(note.mime)}`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
