// End-to-end check of the built app (dist/) in real Chromium with a fake microphone, against the reference receiver.
// Usage: npm run build && node scripts/e2e.mjs      (CHROMIUM_PATH overrides the browser location)
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createApp } from '../server/src/app.ts'
import { loadConfig } from '../server/src/config.ts'

// The real backend (upload endpoint and storage) with transcription and the worker switched off.
function createReceiver({ token, dataDir }) {
  const app = createApp(loadConfig({ INGEST_TOKEN: token, DATA_DIR: dataDir, HOST: '127.0.0.1', WORKER: '0', GIT: '0' }), { log: () => {} })
  return {
    inbox: app.brain.store.inbox,
    notes: () => app.brain.store.ids(),
    async listen(port) { await app.start(); return app.listen(port) },
    close: () => app.close(),
  }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const shots = join(root, 'artifacts', 'e2e')
await mkdir(shots, { recursive: true })
const TOKEN = 'e2e-token-0123456789abcdef'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

// Static server for dist/ (the same files a real host would serve).
const app = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://x').pathname
  const file = normalize(join(root, 'dist', path === '/' ? 'index.html' : path))
  if (!file.startsWith(join(root, 'dist'))) { response.writeHead(403); return response.end() }
  try {
    const body = await readFile(file)
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
    response.end(body)
  } catch { response.writeHead(404); response.end() }
})
await new Promise(done => app.listen(0, '127.0.0.1', done))
const APP = `http://localhost:${app.address().port}`

const dataDir = await mkdtemp(join(tmpdir(), 'tv-e2e-'))
let receiver = createReceiver({ token: TOKEN, dataDir })
const receiverPort = await receiver.listen(0)
const ENDPOINT = `http://127.0.0.1:${receiverPort}`

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'], deviceScaleFactor: 2 })
const problems = []
const watch = page => {
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`))
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) problems.push(`console: ${message.text()}`) })
}

const results = []
async function step(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`) }
  catch (error) { results.push({ name, ok: false, error }); console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').slice(0, 4).join('\n       ')}`) }
}
async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(done => setTimeout(done, 150))
  }
}
const stored = async () => (await receiver.notes()).sort()
const metaOf = async id => JSON.parse(await readFile(join(receiver.inbox, id, 'meta.json'), 'utf8'))
async function waitForNotes(count, what) { return until(async () => ((await stored()).length === count ? stored() : false), what) }

async function recordNote(page, { seconds = 2.5, markAt = null } = {}) {
  await page.getByRole('button', { name: 'Start recording' }).click()
  await page.getByRole('button', { name: 'Stop and save' }).waitFor()
  if (markAt !== null) { await page.waitForTimeout(markAt * 1000); await page.keyboard.press('m') }
  await page.waitForTimeout((seconds - (markAt ?? 0)) * 1000)
  await page.getByRole('button', { name: 'Stop and save' }).click()
  await page.getByRole('button', { name: 'Start recording' }).waitFor()
}
const wav = () => { // one second of silence, 8 kHz mono 16-bit
  const samples = 8000
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24)
  buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

const page = await context.newPage()
watch(page)
console.log(`App ${APP}  receiver ${ENDPOINT}`)

await step('opens on the Record screen with no console errors', async () => {
  await page.goto(`${APP}/`)
  await page.getByRole('heading', { name: 'Record', level: 1 }).waitFor()
  assert.equal(await page.title(), 'Trapper Voice')
  await page.screenshot({ path: join(shots, '01-record-idle-phone.png') })
})

await step('pairing link fills in the connection and removes itself from the address', async () => {
  await page.goto(`${APP}/#/pair?e=${encodeURIComponent(ENDPOINT)}&t=${TOKEN}&n=E2E%20phone`)
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor()
  await page.getByText('Paired. Use “Test connection” to check it.').waitFor()
  assert.equal(await page.getByLabel('Server address').inputValue(), ENDPOINT)
  assert.equal(new URL(page.url()).hash, '#/settings')
  assert.ok(!page.url().includes(TOKEN), 'the token must not stay in the URL')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await page.getByText('Connected. The server accepted the token.').waitFor()
  await page.screenshot({ path: join(shots, '02-settings-phone.png'), fullPage: true })
})

await step('records, marks a moment, and uploads by itself after Stop', async () => {
  await page.goto(`${APP}/#/record`)
  await page.getByRole('heading', { name: 'Record', level: 1 }).waitFor()
  await page.getByRole('button', { name: 'Start recording' }).click()
  await page.getByRole('button', { name: 'Stop and save' }).waitFor()
  await page.waitForTimeout(1000)
  await page.keyboard.press('m')
  await page.waitForTimeout(1800)
  await page.screenshot({ path: join(shots, '03-record-recording-phone.png') })
  const clock = await page.locator('.timer-display').innerText()
  assert.match(clock, /^00:00:0[2-4]$/, `clock ${clock}`)
  await page.getByRole('button', { name: 'Stop and save' }).click()
  const [id] = await waitForNotes(1, 'first note on the server')
  const meta = await metaOf(id)
  assert.ok(meta.durationMs > 2000 && meta.durationMs < 5000, `duration ${meta.durationMs}`)
  assert.equal(meta.marks.length, 1)
  assert.ok(meta.marks[0] > 500 && meta.marks[0] < 2500, `mark ${meta.marks[0]}`)
  assert.equal(meta.device, 'E2E phone')
  assert.match(meta.mime, /^audio\/webm/)
  const audio = await readFile(join(receiver.inbox, id, meta.audioFile))
  assert.ok(audio.length > 1000, `audio ${audio.length} bytes`)
  assert.deepEqual([...audio.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], 'a WebM (EBML) header')
  await page.getByText(/Saved \d+s\. Uploaded\./).waitFor()
})

await step('Library shows the note as Uploaded and plays it back', async () => {
  await page.goto(`${APP}/#/library`)
  await page.getByRole('heading', { name: 'Library', level: 1 }).waitFor()
  await page.getByRole('button', { name: /Voice note/ }).first().click()
  await page.locator('.note-row audio').waitFor()
  await page.getByText('Marked moments').waitFor()
  await page.getByText('Uploaded', { exact: true }).first().waitFor()
  const duration = await page.locator('.note-row audio').evaluate(audio => new Promise(resolve => {
    const done = () => resolve(audio.duration)
    if (audio.readyState > 0) done(); else audio.addEventListener('loadedmetadata', done, { once: true })
  }))
  assert.ok(duration === Infinity || duration > 1, `audio duration ${duration}`) // MediaRecorder WebM has no duration header; the app stores its own
  await page.screenshot({ path: join(shots, '04-library-phone.png'), fullPage: true })
})

await step('keyboard: Space starts and stops, M marks (focus stays on the button)', async () => {
  await page.goto(`${APP}/#/record`)
  await page.getByRole('heading', { name: 'Record', level: 1 }).waitFor()
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Stop and save' }).waitFor()
  await page.getByRole('button', { name: 'Stop and save' }).focus()
  await page.keyboard.press('m')
  await page.getByText(/1 moment marked/).waitFor()
  await page.waitForTimeout(1200)
  await page.keyboard.press('Space') // button is focused, so it activates natively
  await page.getByRole('button', { name: 'Start recording' }).waitFor()
  await waitForNotes(2, 'second note')
})

await step('pause excludes paused time from the recording length', async () => {
  await page.getByRole('button', { name: 'Start recording' }).click()
  await page.getByRole('button', { name: 'Stop and save' }).waitFor()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Pause recording' }).click()
  await page.getByText('Paused. Resume or stop to save.').waitFor()
  await page.waitForTimeout(3000)
  await page.getByRole('button', { name: 'Resume recording' }).click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Stop and save' }).click()
  const ids = await waitForNotes(3, 'third note')
  const durations = await Promise.all(ids.map(async id => (await metaOf(id)).durationMs))
  const paused = durations.find(ms => ms > 2000 && ms < 3600)
  assert.ok(paused, `a ~2.7s note (paused 3s excluded), got ${durations}`)
})

await step('offline: saves on the device, then uploads on its own when the connection returns', async () => {
  await context.setOffline(true)
  await page.getByText(/You’re offline/).waitFor()
  await recordNote(page, { seconds: 2 })
  await page.getByText(/Saved \d+s\. (Waiting for a connection|Will retry in)/).waitFor()
  await page.waitForTimeout(500)
  assert.equal((await stored()).length, 3, 'nothing may reach the server while offline')
  await page.screenshot({ path: join(shots, '05-offline-phone.png') })
  await context.setOffline(false)
  await waitForNotes(4, 'offline note after reconnect')
})

await step('server down: retries by itself with backoff, then succeeds when it is back', async () => {
  await receiver.close()
  try {
    await recordNote(page, { seconds: 2 })
    await page.locator('.timer-message').getByText(/Will retry in \d+s/).waitFor({ timeout: 15_000 })
    assert.equal((await readdirCount()), 4)
  } finally {
    receiver = createReceiver({ token: TOKEN, dataDir })
    await receiver.listen(receiverPort)
  }
  await waitForNotes(5, 'note after the server came back') // first retry is due in ~5s
})
async function readdirCount() { return (await stored()).length }

await step('wrong token: asks for attention, then recovers once the token is fixed', async () => {
  await page.goto(`${APP}/#/settings`)
  const tokenField = page.locator('label:has-text("Access token") input')
  await tokenField.fill('not-the-token')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.goto(`${APP}/#/record`)
  await recordNote(page, { seconds: 2 })
  await page.goto(`${APP}/#/library`)
  await page.getByText('Needs attention').first().waitFor({ timeout: 15_000 })
  await page.getByText(/rejected the access token/).first().waitFor()
  await page.getByText(/1 note needs attention/).waitFor()
  await page.screenshot({ path: join(shots, '06-needs-attention-phone.png'), fullPage: true })
  assert.equal((await stored()).length, 5)
  await page.goto(`${APP}/#/settings`)
  await page.locator('label:has-text("Access token") input').fill(TOKEN)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await waitForNotes(6, 'note after fixing the token')
})

await step('delete has an Undo window, then removes only the local copy', async () => {
  await page.goto(`${APP}/#/library`)
  const rows = page.locator('.note-row')
  await rows.first().waitFor()
  const before = await rows.count()
  await rows.first().getByRole('button').first().click()
  await rows.first().getByRole('button', { name: 'Delete' }).click()
  assert.equal(await rows.count(), before - 1)
  await page.getByRole('button', { name: 'Undo' }).click()
  assert.equal(await rows.count(), before)
  await rows.first().getByRole('button').first().click() // the restored row is collapsed again
  await rows.first().getByRole('button', { name: 'Delete' }).click()
  await page.waitForTimeout(8000)
  assert.equal(await rows.count(), before - 1)
  await page.reload()
  await page.locator('.note-row').first().waitFor()
  assert.equal(await page.locator('.note-row').count(), before - 1, 'deletion persists')
  assert.equal((await stored()).length, 6, 'the server copy is untouched')
})

await step('crash recovery: an unfinished recording is rebuilt and uploaded on next launch', async () => {
  const victim = await context.newPage()
  watch(victim)
  await victim.goto(`${APP}/#/record`)
  await victim.getByRole('button', { name: 'Start recording' }).click()
  await victim.getByRole('button', { name: 'Stop and save' }).waitFor()
  await victim.waitForTimeout(3600) // at least three one-second chunks reach IndexedDB
  await victim.close({ runBeforeUnload: false }) // tab dies mid-recording
  await page.bringToFront()
  await page.goto(`${APP}/#/record`)
  await page.reload()
  await page.getByText(/Recovered 1 unfinished recording/).waitFor({ timeout: 15_000 })
  const ids = await waitForNotes(7, 'recovered note on the server')
  const metas = await Promise.all(ids.map(metaOf))
  const recovered = metas.find(meta => meta.recovered)
  assert.ok(recovered, 'meta.recovered is true')
  assert.ok(recovered.durationMs >= 2000, `recovered duration ${recovered.durationMs}`)
  const audio = await readFile(join(receiver.inbox, recovered.id, recovered.audioFile))
  assert.ok(audio.length > 1000)
})

await step('importing an existing audio file queues and uploads it', async () => {
  await page.goto(`${APP}/#/library`)
  await page.locator('input[type=file]').setInputFiles({ name: 'old memo.wav', mimeType: 'audio/wav', buffer: wav() })
  await page.getByText('Added 1 recording to the upload queue.').waitFor()
  const ids = await waitForNotes(8, 'imported note')
  const metas = await Promise.all(ids.map(metaOf))
  const imported = metas.find(meta => meta.source === 'import')
  assert.ok(imported, 'import source recorded')
  assert.equal(imported.title, 'old memo')
  assert.equal(imported.mime, 'audio/wav')
})

await step('works offline from the first launch, and uploads from the service worker with every tab closed', async () => {
  await page.goto(`${APP}/#/record`)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await until(() => context.serviceWorkers().length > 0, 'service worker')
  await page.reload()
  await until(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'page controlled by the service worker')
  // 1. the app shell opens with no network
  await context.setOffline(true)
  await page.reload()
  await page.getByRole('heading', { name: 'Record', level: 1 }).waitFor()
  await page.getByText(/You’re offline/).waitFor()
  // 2. record offline, close every tab
  await recordNote(page, { seconds: 2 })
  await page.getByText(/Saved \d+s\. (Waiting for a connection|Will retry in)/).waitFor()
  const keepAlive = await context.newPage()
  await page.close()
  assert.equal((await stored()).length, 8)
  // 3. network returns; only the service worker is left to do the upload
  await context.setOffline(false)
  const worker = context.serviceWorkers()[0]
  await worker.evaluate(() => flush({ ignoreBackoff: true }))
  await waitForNotes(9, 'upload from the service worker')
  await keepAlive.goto(`${APP}/#/library`)
  await keepAlive.getByText('Uploaded', { exact: true }).first().waitFor()
  await keepAlive.close()
})

await step('no page error or console error occurred', async () => assert.deepEqual(problems, []))

await step('layout: no sideways scrolling at 320px, every button has a name, desktop looks right', async () => {
  const narrow = await context.newPage()
  watch(narrow)
  await narrow.setViewportSize({ width: 320, height: 640 })
  for (const hash of ['record', 'library', 'settings']) {
    await narrow.goto(`${APP}/#/${hash}`)
    await narrow.waitForTimeout(400)
    const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 0, `${hash}: page is ${overflow}px wider than 320px`)
    const unnamed = await narrow.evaluate(() => [...document.querySelectorAll('button')].filter(button => !(button.innerText.trim() || button.getAttribute('aria-label'))).length)
    assert.equal(unnamed, 0, `${hash}: buttons without a name`)
  }
  await narrow.setViewportSize({ width: 1280, height: 800 })
  await narrow.goto(`${APP}/#/record`)
  await narrow.waitForTimeout(400)
  await narrow.screenshot({ path: join(shots, '07-record-desktop.png') })
  await narrow.goto(`${APP}/#/library`)
  await narrow.getByRole('button', { name: /Voice note|old memo/ }).first().click()
  await narrow.waitForTimeout(400)
  await narrow.screenshot({ path: join(shots, '08-library-desktop.png') })
  await narrow.goto(`${APP}/#/settings`)
  await narrow.waitForTimeout(400)
  await narrow.screenshot({ path: join(shots, '09-settings-desktop.png'), fullPage: true })
  await narrow.close()
})

await browser.close()
await receiver.close()
app.close()
await rm(dataDir, { recursive: true, force: true })

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${shots}`)
process.exit(failed.length ? 1 : 0)
