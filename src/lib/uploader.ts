import { getAudio, getNote, listNotes, removeAudio, updateNote } from './db'
import { notifyChanged } from './changes'
import { normalizeEndpoint } from './endpoint'
import { errorMessage } from './errors'
import { extensionFor } from './mime'
import { ServerError, authHeaders, editOnServer } from './server'
import { classifyStatus, retryDelayMs, statusMessage, uploadTimeoutMs } from './rules'
import { loadSettings } from './settings'
import { APP_VERSION, type Note, type Settings } from './types'

const LOCK = 'tv-upload'

export function uploadMeta(note: Note, settings: Settings) {
  return {
    id: note.id,
    createdAt: new Date(note.createdAt).toISOString(),
    durationMs: note.durationMs,
    mime: note.mime,
    size: note.size,
    title: note.title,
    tags: note.tags,
    marks: note.marks,
    recovered: note.recovered,
    source: note.source,
    device: settings.deviceName,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -new Date(note.createdAt).getTimezoneOffset(),
    app: `voicebrain-app/${APP_VERSION}`,
  }
}

export interface PingResult { ok: boolean; message: string }

/** Checks the address and token with `GET /v1/ping`. */
export async function pingServer(settings: Pick<Settings, 'endpoint' | 'token'>): Promise<PingResult> {
  const endpoint = normalizeEndpoint(settings.endpoint)
  if (!endpoint) return { ok: false, message: 'Enter the server address first.' }
  try {
    const response = await fetch(`${endpoint}/v1/ping`, { headers: authHeaders(settings), signal: AbortSignal.timeout(10_000) })
    if (response.ok) return { ok: true, message: 'Connected. The server accepted the token.' }
    return { ok: false, message: statusMessage(response.status) }
  } catch (error) {
    return { ok: false, message: `Could not reach the server. ${errorMessage(error)}` }
  }
}

async function uploadOne(id: string, settings: Settings): Promise<void> {
  const note = await getNote(id)
  if (!note) return
  const endpoint = normalizeEndpoint(settings.endpoint)
  const attempts = note.attempts + 1
  await updateNote(id, { status: 'uploading', attempts })
  notifyChanged()

  const blob = await getAudio(id)
  if (!blob) {
    await updateNote(id, { status: 'failed', lastError: 'The audio file is missing from this device.', nextAttemptAt: null })
    return
  }

  const form = new FormData()
  form.append('meta', JSON.stringify(uploadMeta(note, settings)))
  form.append('audio', blob, `${note.id}.${extensionFor(note.mime)}`)

  try {
    const response = await fetch(`${endpoint}/v1/notes`, {
      method: 'POST',
      headers: { ...authHeaders(settings), 'Idempotency-Key': note.id },
      body: form,
      signal: AbortSignal.timeout(uploadTimeoutMs(blob.size)),
    })
    const outcome = classifyStatus(response.status)
    if (outcome === 'ok') {
      await updateNote(id, { status: 'uploaded', uploadedAt: Date.now(), lastError: null, nextAttemptAt: null })
      if (settings.keepAfterUpload === 0) {
        await removeAudio(id)
        await updateNote(id, { audioRemoved: true })
      }
    } else if (outcome === 'retry') {
      const retryAfter = Number(response.headers.get('Retry-After')) || 0
      await updateNote(id, { status: 'local', lastError: statusMessage(response.status), nextAttemptAt: Date.now() + retryDelayMs(attempts, Math.random, retryAfter) })
    } else {
      await updateNote(id, { status: 'failed', lastError: statusMessage(response.status), nextAttemptAt: null })
    }
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
    await updateNote(id, {
      status: 'local',
      lastError: timedOut ? 'The upload took too long.' : 'No connection to the server.',
      nextAttemptAt: Date.now() + retryDelayMs(attempts),
    })
  }
}

export interface FlushOptions {
  /** Upload even when automatic upload is off, and retry notes that need attention. */
  force?: boolean
  /** Ignore the retry delay (used when the network has just come back). */
  ignoreBackoff?: boolean
  onlyId?: string
}

/** Uploads waiting notes one at a time. The lock keeps this page and the service worker from sending the same note twice. */
export async function flushUploads(options: FlushOptions = {}): Promise<void> {
  const run = async () => {
    const settings = await loadSettings()
    if (!normalizeEndpoint(settings.endpoint)) return
    if (!settings.autoUpload && !options.force) return
    const tried = new Set<string>()
    for (;;) {
      const now = Date.now()
      const next = (await listNotes()).reverse().find(note => {
        if (tried.has(note.id)) return false
        if (options.onlyId && note.id !== options.onlyId) return false
        if (note.status === 'uploading') return true // left behind by an uploader that stopped; we hold the lock
        if (note.status === 'failed') return options.force === true && (!options.onlyId || note.id === options.onlyId)
        if (note.status !== 'local') return false
        return options.ignoreBackoff === true || options.force === true || note.nextAttemptAt === null || note.nextAttemptAt <= now
      })
      if (!next) return
      tried.add(next.id)
      await uploadOne(next.id, settings)
      notifyChanged()
    }
  }
  if (navigator.locks) await navigator.locks.request(LOCK, { ifAvailable: true }, lock => (lock ? run() : undefined))
  else await run()
}

/** The earliest moment a waiting note becomes eligible again, or null. */
export async function nextRetryAt(): Promise<number | null> {
  const times = (await listNotes()).filter(note => note.status === 'local' && note.nextAttemptAt !== null).map(note => note.nextAttemptAt as number)
  return times.length ? Math.min(...times) : null
}

/** Sends renames and tag changes made after a note was uploaded. They stay queued until the server has them. */
export async function flushEdits(): Promise<void> {
  const settings = await loadSettings()
  if (!normalizeEndpoint(settings.endpoint)) return
  let sent = false
  for (const note of await listNotes()) {
    if (!note.editPending || note.status !== 'uploaded') continue
    try {
      await editOnServer(settings, note.id, { title: note.title, tags: note.tags })
      const fresh = await getNote(note.id) // keep the flag if the person edited again while this was in flight
      if (fresh && fresh.title === note.title && fresh.tags.join('\n') === note.tags.join('\n')) { await updateNote(note.id, { editPending: false }); sent = true }
    } catch (error) {
      if (error instanceof ServerError && (error.status === 401 || error.status === 403)) return // not connected: nothing will work until it is
    }
  }
  if (sent) notifyChanged()
}

export async function registerBackgroundSync(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.ready
    const sync = (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } } | undefined)?.sync
    await sync?.register('tv-upload')
  } catch {
    // Background Sync is not available everywhere; uploads still run whenever the app is open.
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
let kicking = false

/** Starts an upload pass now (debounced) and schedules the next retry. Safe to call often. */
export function kickUploads(options: FlushOptions = {}): void {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    if (kicking) return kickUploads(options)
    kicking = true
    try {
      await flushUploads(options)
      await flushEdits()
      void registerBackgroundSync()
    } finally {
      kicking = false
    }
    const retryAt = await nextRetryAt()
    const editsWaiting = (await listNotes()).some(note => note.editPending && note.status === 'uploaded')
    const at = retryAt ?? (editsWaiting ? Date.now() + 30_000 : null)
    if (at !== null) timer = setTimeout(() => kickUploads(), Math.max(1000, at - Date.now()))
  }, 250)
}
