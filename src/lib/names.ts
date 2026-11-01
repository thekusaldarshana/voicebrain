import { notifyChanged } from './changes'
import { getNote, listNotes, updateNote } from './db'
import { isConfigured } from './endpoint'
import { fetchServerNotes, type ServerNote } from './server'
import { loadSettings } from './settings'
import type { Note } from './types'

/**
 * What to change on a note on this device, given what the server says about it. The server's name is kept beside the
 * person's own, never over it: a name typed here and not sent yet always wins, and a name the person typed on another
 * device is taken. A Drive link is only ever added or changed, never cleared, because "no link" can just mean Drive was busy.
 */
export function namePatch(note: Note, server: ServerNote): Partial<Note> {
  const patch: Partial<Note> = {}
  if (server.title && server.title !== note.remoteTitle) patch.remoteTitle = server.title
  if (server.drive && server.drive !== note.driveUrl) patch.driveUrl = server.drive
  if (!note.editPending && server.userTitle && server.userTitle !== note.title) patch.title = server.userTitle
  return patch
}

let running = false

/** Pulls the server's names and Drive links for the notes on this device. Safe to call often; quiet when nothing changed. */
export async function syncNames(): Promise<number> {
  if (running) return 0
  running = true
  try {
    const settings = await loadSettings()
    if (!isConfigured(settings)) return 0
    const remote = await fetchServerNotes(settings)
    if (!remote) return 0
    const known = new Set((await listNotes()).map(note => note.id))
    let changed = 0
    for (const server of remote) {
      if (!known.has(server.id)) continue
      const note = await getNote(server.id)
      if (!note) continue
      const patch = namePatch(note, server)
      if (Object.keys(patch).length) { await updateNote(server.id, patch); changed += 1 }
    }
    if (changed) notifyChanged()
    return changed
  } finally { running = false }
}
