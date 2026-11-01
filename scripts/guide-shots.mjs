// Takes the pictures used by the user guide (public/guide/*.png) from the real built app (dist/), with a few made-up notes.
// Usage: npm run build && node scripts/guide-shots.mjs      (CHROMIUM_PATH overrides the browser location; needs to run as root or
// otherwise be allowed to listen on port 80, so the screenshots show a tidy address instead of 127.0.0.1:12345)
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createApp } from '../server/src/app.ts'
import { loadConfig } from '../server/src/config.ts'
import { Devices } from '../server/src/devices.ts'
import { OwnerOAuthProvider } from '../server/src/oauth.ts'
import { Pairing } from '../server/src/pairing.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'public', 'guide')
await mkdir(out, { recursive: true })
const HOST = 'voicebrain.example.com'
const ENDPOINT = `http://${HOST}`
const TOKEN = 'guide-token-0123456789abcdef'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

const site = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://x').pathname
  const file = normalize(join(root, 'dist', path === '/' ? 'index.html' : path))
  if (!file.startsWith(join(root, 'dist'))) { response.writeHead(403); return response.end() }
  try { response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); response.end(await readFile(file)) } catch { response.writeHead(404); response.end() }
})
await new Promise(done => site.listen(0, '127.0.0.1', done))
const APP = `http://localhost:${site.address().port}`

const dataDir = await mkdtemp(join(tmpdir(), 'vb-guide-'))
const server = createApp(loadConfig({ INGEST_TOKEN: TOKEN, DATA_DIR: dataDir, HOST: '127.0.0.1', WORKER: '0', GIT: '0' }), { log: () => {} })
await server.start()
await server.listen(80)

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`],
})
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'], deviceScaleFactor: 2 })
// The guide shows a signed-in person and a connected Drive, which the plain test server (no Google) does not have.
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' }
const answer = body => route => route.request().method() === 'OPTIONS'
  ? route.fulfill({ status: 204, headers: cors })
  : route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) })
await context.route('**/v1/me', answer({ device: { id: 'd', name: 'Phone' }, userId: 'u', account: { email: 'you@example.com', name: 'You' }, pairing: true }))
await context.route('**/v1/drive', answer({ enabled: true, connected: true, canConnect: true, connectPath: '/auth/drive/start' }))
const page = await context.newPage()
const shot = async (name, target = page, options = {}) => { await target.screenshot({ path: join(out, name), ...options }); console.log(`  ${name}`) }
const uploaded = async count => { for (let i = 0; i < 100; i += 1) { if ((await server.brain.store.ids()).length >= count) return; await page.waitForTimeout(150) } throw new Error('upload did not finish') }

// 1. Before signing in.
await page.goto(`${APP}/`)
await page.getByRole('heading', { name: 'Record', level: 1 }).waitFor()
await shot('signin.png')

// 2. Signed in, ready to record, then recording.
await page.goto(`${APP}/#/pair?e=${encodeURIComponent(ENDPOINT)}&t=${TOKEN}&n=Phone`)
await page.getByText('Paired. Use “Test connection” to check it.').waitFor()
await page.goto(`${APP}/#/record`)
await page.getByRole('heading', { name: 'Record', level: 1 }).waitFor()
await shot('record.png')
for (let n = 1; n <= 3; n += 1) {
  await page.getByRole('button', { name: 'Start recording' }).click()
  await page.getByRole('button', { name: 'Stop and save' }).waitFor()
  await page.waitForTimeout(n === 1 ? 3200 : 2200)
  if (n === 1) await shot('recording.png')
  await page.getByRole('button', { name: 'Stop and save' }).click()
  await page.getByRole('button', { name: 'Start recording' }).waitFor()
  await uploaded(n)
}

// 3. Give the notes the names a real day would: one by ChatGPT, one by the person, one the model's.
await page.evaluate(async patches => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('trapper-voice'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  const tx = db.transaction('notes', 'readwrite')
  const store = tx.objectStore('notes')
  const all = await new Promise(resolve => { const request = store.getAll(); request.onsuccess = () => resolve(request.result) })
  all.sort((a, b) => a.createdAt - b.createdAt).forEach((note, index) => store.put({ ...note, ...patches[index] }))
  await new Promise(resolve => { tx.oncomplete = resolve })
}, [
  { remoteTitle: 'Thoughts on learning physics', tags: ['physics'] },
  { title: 'Call the bank', tags: ['task'] },
  { remoteTitle: 'Rutherford and the gold foil', tags: ['physics', 'history'], driveUrl: 'https://drive.google.com/drive/folders/example' },
])
await page.goto(`${APP}/#/library`)
await page.reload()
await page.getByRole('heading', { name: 'Library', level: 1 }).waitFor()
await page.getByText('Rutherford and the gold foil').first().waitFor()
await shot('library.png')
await page.getByRole('button', { name: /Rutherford and the gold foil/ }).click()
await page.getByRole('link', { name: 'Open in Google Drive' }).waitFor()
await shot('note.png', page.locator('li.note-row[data-status]').filter({ hasText: 'Rutherford' }))

// 4. Settings: who is signed in, and Drive.
await page.goto(`${APP}/#/settings`)
await page.getByText('you@example.com').waitFor()
await shot('settings.png', page.locator('.settings-section').first())

// 5. The two approval pages the server shows. They are rendered from the server's own page code, for a made-up person.
const view = await context.newPage()
const pairing = new Pairing({ devices: new Devices(join(dataDir, 'guide-devices.sqlite')), publicUrl: 'https://voicebrain.example.com' })
const { userCode } = pairing.start('Phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', '203.0.113.7')
await view.setContent(pairing.page(userCode, '', '', 'you@example.com'))
await shot('approve-device.png', view.locator('main'))
const oauth = new OwnerOAuthProvider({ dbPath: ':memory:', approver: { kind: 'google', userOf: () => null, signInUrl: () => '/', originOk: () => true }, staticToken: '' })
await view.setContent(oauth.page('guide', { client_id: 'chatgpt', client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector/oauth/example'] }, '', 'you@example.com'))
await shot('approve-chatgpt.png', view.locator('main'))

console.log(`done: ${(await readdir(out)).filter(name => name.endsWith('.png')).length} pictures in public/guide`)
await browser.close()
await server.close()
site.close()
