import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Browser, CLIENT_ID, CLIENT_SECRET, FakeGoogle, connectDrive, signIn, type Identity } from './fake-google.ts'
import { FakeDrive } from './fake-drive.ts'
import { INGEST, NOTE_ID, freePort, run, tempDir, testConfig, upload, waitFor, type Running } from './helpers.ts'

const ALICE: Identity = { sub: '1001', email: 'alice@example.com', name: 'Alice' }
const OTHER_NOTE = '55555555-5555-4555-8555-555555555555'
const json = { 'Content-Type': 'application/json' }
const exists = (path: string) => stat(path).then(() => true, () => false)

let google: FakeGoogle
let drive: FakeDrive
let dir: Awaited<ReturnType<typeof tempDir>>
let server: Running
let origin = ''

beforeAll(async () => { google = await FakeGoogle.start(); drive = await new FakeDrive().start(); process.env.STORAGE_BACKEND = 'drive' })
afterAll(async () => { delete process.env.STORAGE_BACKEND; await google.close(); await drive.close() })
const KEY = randomBytes(32).toString('base64')
async function boot() {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = await run(testConfig(dir.dir, { port, publicUrl: origin, googleClientId: CLIENT_ID, googleClientSecret: CLIENT_SECRET, allowedEmails: [ALICE.email], driveEnabled: true, tokenEncryptionKey: KEY, workerEnabled: false }), fetch, { googleEndpoints: google.endpoints, driveApi: { apiBase: drive.apiBase, uploadBase: drive.uploadBase } })
}
beforeEach(async () => {
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined)
  dir = await tempDir()
  await boot()
})
afterEach(async () => { vi.restoreAllMocks(); await server.stop(); await dir.clean() })

async function connect(browser: Browser) {
  expect((await connectDrive(browser, origin, google, ALICE)).status).toBe(200)
  // Alice's Drive access token was minted by the sign-in flow; tell the fake Drive whose it is.
  drive.tokenAccounts.set(await (server.app.drive as { accessToken(id: string): Promise<string> }).accessToken(ALICE.sub), 'alice')
}
async function pairedDevice(browser: Browser) {
  const start = (await (await fetch(`${origin}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: 'Phone' }) })).json()) as { pairId: string; pollToken: string; userCode: string }
  await browser.form(`${origin}/pair/decision`, { code: start.userCode, decision: 'approve' }, { Origin: origin })
  return ((await (await fetch(`${origin}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }) })).json()) as { token: string }).token
}

async function connectedDevice() {
  const browser = new Browser()
  expect((await signIn(browser, origin, google, ALICE)).status).toBe(302)
  await connect(browser)
  return pairedDevice(browser)
}

describe('STORAGE_BACKEND=drive, end to end', () => {
  it('keeps a signed-in person’s notes in their Drive and not on this disk, and deleting removes them from Drive', async () => {
    const token = await connectedDevice()
    expect((await upload(origin, { id: NOTE_ID, token })).status).toBe(201)
    await waitFor(() => drive.files('alice').some(file => file.name === NOTE_ID), 'the note folder in Alice’s Drive')
    expect(drive.files('alice').some(file => file.name === 'meta.json')).toBe(true)
    expect(await exists(join(dir.dir, 'users', ALICE.sub, 'inbox', NOTE_ID))).toBe(false)
    expect(await exists(join(dir.dir, 'inbox', NOTE_ID))).toBe(false)

    expect((await fetch(`${origin}/v1/notes/${NOTE_ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(204)
    expect(drive.files('alice').some(file => file.name === NOTE_ID)).toBe(false)
  })

  it('keeps the owner identity’s notes on this disk, because it has no Google account', async () => {
    expect((await upload(origin, { id: OTHER_NOTE, token: INGEST })).status).toBe(201)
    expect(await readdir(join(dir.dir, 'inbox'))).toContain(OTHER_NOTE)
    expect(drive.files('owner')).toEqual([])
  })

  it('refuses to start with the Drive backend but Drive switched off', async () => {
    const { createApp } = await import('../src/app.ts')
    expect(() => createApp(testConfig(dir.dir, { workerEnabled: false }))).toThrow(/needs DRIVE_ENABLED=1/)
  })

  it('does not fall over for someone who has signed in but not connected Drive: they are told, everyone else carries on', async () => {
    const browser = new Browser()
    expect((await signIn(browser, origin, google, ALICE)).status).toBe(302)
    const token = await pairedDevice(browser)
    // A restart with Alice already known to the server (this crash-looped the real server once).
    await server.stop()
    await boot()
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ ok: true })

    const refused = await upload(origin, { id: NOTE_ID, token })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'drive-not-connected', connectPath: '/auth/drive/start' })
    const status = await fetch(`${origin}/v1/status`, { headers: { Authorization: `Bearer ${token}` } })
    expect(status.status).toBe(409)
    expect((await upload(origin, { id: OTHER_NOTE, token: INGEST })).status).toBe(201) // the owner identity is unaffected
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ ok: true })

    // Once connected, the same device works without a restart.
    await connect(browser)
    expect((await upload(origin, { id: NOTE_ID, token })).status).toBe(201)
    await waitFor(() => drive.files('alice').some(file => file.name === NOTE_ID), 'the note in Alice’s Drive')
  })
})
