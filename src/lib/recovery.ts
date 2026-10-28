import { clearChunks, deleteNoteCompletely, listNotes, readChunks, saveAudio, updateNote } from './db'
import { notifyChanged } from './changes'

/**
 * Notes still marked `recording` belong to a recording that was cut off (crash, closed tab, dead battery).
 * Their audio was saved in one-second chunks, so rebuild the file and queue it like any other note.
 * Returns how many notes were recovered.
 */
export async function recoverInterrupted(): Promise<number> {
  const held = new Set<string>()
  try {
    const state = await navigator.locks?.query()
    for (const lock of state?.held ?? []) if (lock.name) held.add(lock.name)
  } catch {
    // Without the Locks API we assume no other tab is recording.
  }

  let recovered = 0
  for (const note of await listNotes()) {
    if (note.status !== 'recording' || held.has(`tv-rec-${note.id}`)) continue
    const chunks = await readChunks(note.id)
    const blob = new Blob(chunks, { type: note.mime.split(';')[0] || 'audio/webm' })
    if (blob.size === 0) {
      await deleteNoteCompletely(note.id)
      continue
    }
    await saveAudio(note.id, blob)
    await updateNote(note.id, { status: 'local', size: blob.size, recovered: true, durationMs: Math.max(note.durationMs, chunks.length * 1000 - 500) })
    await clearChunks(note.id)
    recovered += 1
  }
  notifyChanged()
  return recovered
}
