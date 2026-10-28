/* Trapper Voice service worker.
 * 1. Opens the app offline (precached build output, filled in by vite.config.ts).
 * 2. Uploads waiting notes when the browser says the network is back, even with the app closed.
 * The upload rules below mirror src/lib/rules.ts; tests/sw-parity.test.ts fails if they drift apart. */

const VERSION = 'dev' /* @version */
const PRECACHE = [] /* @precache */
const CACHE = `tv-${VERSION}`
const DB_NAME = 'trapper-voice'
const LOCK = 'tv-upload'
const APP_VERSION = '0.1.0'

/* ---- upload rules (keep identical to src/lib/rules.ts) ---- */

function classifyStatus(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 409) return 'ok'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry'
  return 'permanent'
}

function retryDelayMs(attempts, random, retryAfterSeconds) {
  const base = Math.min(15 * 60000, 5000 * 2 ** Math.max(0, attempts - 1))
  const delay = Math.round(base * (0.8 + (random || Math.random)() * 0.4))
  return retryAfterSeconds > 0 ? Math.max(delay, Math.min(retryAfterSeconds, 3600) * 1000) : delay
}

function uploadTimeoutMs(size) {
  return Math.min(15 * 60000, 60000 + Math.ceil(size / 50000) * 1000)
}

function statusMessage(status) {
  if (status === 401 || status === 403) return 'The server rejected the access token.'
  if (status === 404) return 'The upload address was not found on the server.'
  if (status === 413) return 'The server says this recording is too large.'
  if (status === 415 || status === 422) return 'The server could not accept this audio format.'
  if (status === 429) return 'The server asked us to slow down.'
  if (status >= 500) return `The server had a problem (${status}).`
  return `The server answered ${status}.`
}

function extensionFor(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase()
  if (base === 'audio/webm') return 'webm'
  if (base === 'audio/mp4' || base === 'audio/x-m4a' || base === 'audio/m4a') return 'm4a'
  if (base === 'audio/ogg') return 'ogg'
  if (base === 'audio/mpeg') return 'mp3'
  if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav'
  if (base === 'audio/aac') return 'aac'
  if (base === 'audio/flac') return 'flac'
  return 'bin'
}

function normalizeEndpoint(input) {
  const text = String(input || '').trim()
  if (!text) return ''
  const local = /^(?:https?:\/\/)?(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^/:@]+\.local)(?::\d+)?(?:[/?#]|$)/i
  const withScheme = /^https?:\/\//i.test(text) ? text : `${local.test(text) ? 'http' : 'https'}://${text}`
  try {
    const url = new URL(withScheme)
    if (!url.hostname) return ''
    return url.origin + url.pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/* ---- IndexedDB (same stores as src/lib/db.ts) ---- */

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME)
    // If the page never created the database there is nothing to upload; do not create an empty one.
    request.onupgradeneeded = () => request.transaction.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('blocked'))
  })
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function allNotes(db) {
  return wrap(db.transaction('notes').objectStore('notes').getAll())
}

async function updateNote(db, id, patch) {
  const tx = db.transaction('notes', 'readwrite')
  const store = tx.objectStore('notes')
  const current = await wrap(store.get(id))
  if (current) store.put(Object.assign({}, current, patch))
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
}

async function removeAudio(db, id) {
  const tx = db.transaction('audio', 'readwrite')
  tx.objectStore('audio').delete(id)
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error) })
}

function broadcastChanged() {
  try {
    const channel = new BroadcastChannel('trapper-voice')
    channel.postMessage({ type: 'changed' })
    channel.close()
  } catch { /* not available */ }
}

/* ---- upload ---- */

async function uploadOne(db, note, settings) {
  const endpoint = normalizeEndpoint(settings.endpoint)
  const attempts = note.attempts + 1
  await updateNote(db, note.id, { status: 'uploading', attempts })
  broadcastChanged()
  const row = await wrap(db.transaction('audio').objectStore('audio').get(note.id))
  if (!row || !row.blob) {
    await updateNote(db, note.id, { status: 'failed', lastError: 'The audio file is missing from this device.', nextAttemptAt: null })
    return
  }
  const meta = {
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
    app: `trapper-voice/${APP_VERSION}`,
  }
  const form = new FormData()
  form.append('meta', JSON.stringify(meta))
  form.append('audio', row.blob, `${note.id}.${extensionFor(note.mime)}`)
  const headers = { 'Idempotency-Key': note.id }
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`
  try {
    const response = await fetch(`${endpoint}/v1/notes`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(uploadTimeoutMs(row.blob.size)) })
    const outcome = classifyStatus(response.status)
    if (outcome === 'ok') {
      await updateNote(db, note.id, { status: 'uploaded', uploadedAt: Date.now(), lastError: null, nextAttemptAt: null })
      if (settings.keepAfterUpload === 0) {
        await removeAudio(db, note.id)
        await updateNote(db, note.id, { audioRemoved: true })
      }
    } else if (outcome === 'retry') {
      const retryAfter = Number(response.headers.get('Retry-After')) || 0
      await updateNote(db, note.id, { status: 'local', lastError: statusMessage(response.status), nextAttemptAt: Date.now() + retryDelayMs(attempts, Math.random, retryAfter) })
    } else {
      await updateNote(db, note.id, { status: 'failed', lastError: statusMessage(response.status), nextAttemptAt: null })
    }
  } catch {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    await updateNote(db, note.id, { status: 'local', lastError: timedOut ? 'The upload took too long.' : 'No connection to the server.', nextAttemptAt: Date.now() + retryDelayMs(attempts) })
  }
}

/** Uploads every waiting note. Resolves with how many are still waiting for a retry. */
async function flush(options) {
  const ignoreBackoff = Boolean(options && options.ignoreBackoff)
  let waiting = 0
  const run = async () => {
    let db
    try { db = await openDb() } catch { return }
    try {
      const settingsRow = await wrap(db.transaction('kv').objectStore('kv').get('settings'))
      if (!settingsRow || !normalizeEndpoint(settingsRow.endpoint) || settingsRow.autoUpload === false) return
      const tried = new Set()
      for (;;) {
        const now = Date.now()
        const notes = (await allNotes(db)).sort((a, b) => a.createdAt - b.createdAt)
        const next = notes.find(note => {
          if (tried.has(note.id)) return false
          if (note.status === 'uploading') return true
          if (note.status !== 'local') return false
          return ignoreBackoff || note.nextAttemptAt === null || note.nextAttemptAt <= now
        })
        if (!next) { waiting = notes.filter(note => note.status === 'local').length; return }
        tried.add(next.id)
        await uploadOne(db, next, settingsRow)
        broadcastChanged()
      }
    } finally {
      db.close()
    }
  }
  if (self.navigator && self.navigator.locks) await self.navigator.locks.request(LOCK, { ifAvailable: true }, lock => (lock ? run() : undefined))
  else await run()
  return waiting
}

/* ---- lifecycle and caching ---- */

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.all(PRECACHE.map(url => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('tv-') && key !== CACHE) await caches.delete(key)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.includes('/v1/') || url.pathname.endsWith('/health')) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('./')) || (await caches.match('index.html')) || Response.error()))
    return
  }
  event.respondWith((async () => {
    const cached = await caches.match(request)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone())
    return response
  })())
})

self.addEventListener('sync', event => {
  if (event.tag !== 'tv-upload') return
  // Rejecting makes the browser try again later while notes are still waiting.
  event.waitUntil(flush({ ignoreBackoff: true }).then(waiting => { if (waiting) throw new Error('uploads still waiting') }))
})

self.addEventListener('message', event => {
  const data = event.data || {}
  if (data.type === 'flush') event.waitUntil(flush({ ignoreBackoff: Boolean(data.ignoreBackoff) }))
  if (data.type === 'skip-waiting') self.skipWaiting()
})
