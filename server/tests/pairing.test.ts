import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Devices } from '../src/devices.ts'
import { Pairing, normalizeCode } from '../src/pairing.ts'
import { INGEST, freePort, run, tempDir, testConfig, upload, type Running } from './helpers.ts'

const PASS = 'correct horse battery'
const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/

describe('Pairing (the logic)', () => {
  let now = 1_000_000
  let devices: Devices
  let pairing: Pairing
  beforeEach(() => {
    now = 1_000_000
    devices = new Devices(':memory:', () => now)
    pairing = new Pairing({ devices, passphrase: PASS, publicUrl: 'https://vb.test', now: () => now })
  })

  it('gives the app a code it can show, a secret only it knows, and the page to open', () => {
    const start = pairing.start('Pixel', 'Chrome', '1.1.1.1')
    expect(start.userCode).toMatch(CODE)
    expect(start.verificationUrl).toBe(`https://vb.test/pair?code=${start.userCode}`)
    expect(start).toMatchObject({ expiresIn: 600, interval: 2 })
    expect(start.pollToken.length).toBeGreaterThan(20)
    expect(pairing.poll(start.pairId, start.pollToken)).toEqual({ status: 'pending' })
  })

  it('never uses characters that are easy to misread', () => {
    const seen = new Set<string>()
    for (let batch = 0; batch < 10; batch += 1) {
      const fresh = new Pairing({ devices, passphrase: PASS, publicUrl: 'https://vb.test', now: () => now })
      for (let n = 0; n < 20; n += 1) seen.add(fresh.start('x', '', `ip-${n}`).userCode)
    }
    expect(seen.size).toBe(200)
    for (const code of seen) expect(code).toMatch(CODE)
    expect([...seen].join('')).not.toMatch(/[ILO01]/)
  })

  it('hands the token to the app once the owner approves with the passphrase, and only once', () => {
    const { pairId, pollToken, userCode } = pairing.start('Pixel', 'Chrome', '1.1.1.1')
    expect(pairing.decide('ZZZZ-ZZZZ', true, PASS, '2.2.2.2')).toEqual({ ok: false, reason: 'unknown' })
    expect(pairing.decide(userCode, true, 'wrong', '2.2.2.2')).toEqual({ ok: false, reason: 'wrong-passphrase' })
    expect(pairing.poll(pairId, pollToken)).toEqual({ status: 'pending' }) // a wrong passphrase approves nothing
    expect(pairing.decide(userCode.toLowerCase().replace('-', ' '), true, PASS, '2.2.2.2')).toEqual({ ok: true, deviceName: 'Pixel' }) // forgiving about how the code is typed
    const approved = pairing.poll(pairId, pollToken)
    expect(approved).toMatchObject({ status: 'approved' })
    const token = (approved as { token: string }).token
    expect(token).toMatch(/^vbd_[A-Za-z0-9_-]{43}$/)
    expect(pairing.poll(pairId, pollToken)).toEqual({ status: 'expired' }) // handed over once
    expect(devices.verify(token)?.name).toBe('Pixel')
  })

  it('does not reveal anything to someone who does not hold the poll secret', () => {
    const { pairId, userCode } = pairing.start('Pixel', '', '1.1.1.1')
    pairing.decide(userCode, true, PASS, '2.2.2.2')
    expect(pairing.poll(pairId, 'guess')).toEqual({ status: 'expired' })
    expect(pairing.poll('11111111-1111-4111-8111-111111111111', 'guess')).toEqual({ status: 'expired' })
  })

  it('lets the owner say no, without a passphrase', () => {
    const { pairId, pollToken, userCode } = pairing.start('Pixel', '', '1.1.1.1')
    expect(pairing.decide(userCode, false, '', '2.2.2.2')).toEqual({ ok: true, deviceName: 'Pixel' })
    expect(pairing.poll(pairId, pollToken)).toEqual({ status: 'denied' })
    expect(devices.list()).toEqual([])
  })

  it('forgets a request after ten minutes', () => {
    const { pairId, pollToken, userCode } = pairing.start('Pixel', '', '1.1.1.1')
    now += 11 * 60_000
    expect(pairing.describe(userCode)).toBeNull()
    expect(pairing.decide(userCode, true, PASS, '2.2.2.2')).toEqual({ ok: false, reason: 'unknown' })
    expect(pairing.poll(pairId, pollToken)).toEqual({ status: 'expired' })
  })

  it('locks the approval after five wrong passphrases from one address, even for the right one', () => {
    const { userCode } = pairing.start('Pixel', '', '1.1.1.1')
    for (let attempt = 0; attempt < 5; attempt += 1) expect(pairing.decide(userCode, true, `wrong-${attempt}`, '9.9.9.9')).toMatchObject({ reason: 'wrong-passphrase' })
    expect(pairing.decide(userCode, true, PASS, '9.9.9.9')).toEqual({ ok: false, reason: 'blocked' })
    expect(pairing.decide(userCode, true, PASS, '8.8.8.8')).toMatchObject({ ok: true }) // another address is not affected
  })

  it('limits how fast one address can ask, and how many requests can wait', () => {
    for (let n = 0; n < 10; n += 1) pairing.start('x', '', '5.5.5.5')
    expect(() => pairing.start('x', '', '5.5.5.5')).toThrow(/Too many pairing requests from this address/)
    now += 3_700_000
    expect(() => pairing.start('x', '', '5.5.5.5')).not.toThrow()
    const crowded = new Pairing({ devices, passphrase: PASS, publicUrl: 'https://vb.test', now: () => now })
    for (let n = 0; n < 20; n += 1) crowded.start('x', '', `ip-${n}`)
    expect(() => crowded.start('x', '', 'ip-21')).toThrow(/waiting/)
  })

  it('shows who is asking, escaped, so a hostile device name cannot run script on the approval page', () => {
    const { userCode } = pairing.start('<img src=x onerror=alert(1)>', '<script>alert(2)</script>', '1.1.1.1')
    const html = pairing.page(userCode)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert')
    expect(pairing.page('NOPE-NOPE')).toContain('not valid')
    expect(pairing.page('', '', 'approved')).toContain('Device connected')
  })

  it('normalizes codes however they are typed', () => {
    expect(normalizeCode('abcd efgh')).toBe('ABCDEFGH')
    expect(normalizeCode(' a-b-c-d-e-f-g-h-i-j ')).toBe('ABCDEFGH')
  })
})

describe('Devices (the registry)', () => {
  it('stores only a hash of each token, so a copy of the file cannot be used to connect', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'devices-'))
    try {
      const devices = new Devices(join(folder, 'devices.sqlite'))
      const { token } = devices.create('Pixel', 'Chrome on Android')
      devices.close()
      const raw = new DatabaseSync(join(folder, 'devices.sqlite'))
      const rows = raw.prepare('SELECT * FROM devices').all() as Array<Record<string, unknown>>
      raw.close()
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain(token)
      expect(JSON.stringify(rows)).not.toContain(token.slice(4, 20))
    } finally { await rm(folder, { recursive: true, force: true }) }
  })

  it('knows each device by its own token, records when it was last seen at most once a minute, and can cut one off', () => {
    let now = Date.parse('2026-11-01T10:00:00Z')
    const devices = new Devices(':memory:', () => now)
    const phone = devices.create('Phone', '')
    const laptop = devices.create('Laptop', '')
    expect(devices.verify(phone.token)?.id).toBe(phone.device.id)
    const first = devices.verify(phone.token)?.lastSeenAt
    now += 30_000
    expect(devices.verify(phone.token)?.lastSeenAt).toBe(first)
    now += 40_000
    expect(devices.verify(phone.token)?.lastSeenAt).not.toBe(first)
    expect(devices.verify('vbd_nope')).toBeNull()
    expect(devices.verify('not-a-device-token')).toBeNull()
    expect(devices.revoke(phone.device.id)).toBe(true)
    expect(devices.revoke(phone.device.id)).toBe(false)
    expect(devices.verify(phone.token)).toBeNull()
    expect(devices.verify(laptop.token)?.name).toBe('Laptop')
    expect(devices.list().map(device => device.name)).toEqual(['Laptop'])
  })
})

describe('pairing over HTTP', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>
  let server: Running
  let origin = ''
  const json = { 'Content-Type': 'application/json' }
  const start = async (name = 'Pixel') => (await (await fetch(`${server.base}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: name }) })).json()) as { pairId: string; pollToken: string; userCode: string; verificationUrl: string }
  const poll = async (s: { pairId: string; pollToken: string }) => (await (await fetch(`${server.base}/v1/pair/poll`, { method: 'POST', headers: json, body: JSON.stringify({ pairId: s.pairId, pollToken: s.pollToken }) })).json()) as { status: string; token?: string; endpoint?: string; deviceId?: string }
  const decide = (code: string, passphrase: string, decision = 'approve') => fetch(`${server.base}/pair/decision`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, passphrase, decision }) })
  const connect = async (name = 'Pixel') => { const s = await start(name); await decide(s.userCode, PASS); const done = await poll(s); return { ...s, token: done.token as string, deviceId: done.deviceId as string } }

  beforeEach(async () => {
    dir = await tempDir()
    const port = await freePort()
    origin = `http://127.0.0.1:${port}`
    server = await run(testConfig(dir.dir, { port, publicUrl: origin, ownerPassphrase: PASS, workerEnabled: false }))
  })
  afterEach(async () => { await server.stop(); await dir.clean() })

  it('connects a device from start to finish, and the token it gets works for the app', async () => {
    const s = await start('My phone')
    expect(s.userCode).toMatch(CODE)
    expect(s.verificationUrl).toBe(`${origin}/pair?code=${s.userCode}`)
    expect(await poll(s)).toEqual({ status: 'pending' })

    const page = await fetch(s.verificationUrl)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('My phone')
    expect(html).toContain(s.userCode)
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")

    const wrong = await decide(s.userCode, 'not the passphrase')
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toContain('not right')
    expect(await poll(s)).toEqual({ status: 'pending' })

    const approved = await decide(s.userCode, PASS)
    expect(approved.status).toBe(200)
    expect(await approved.text()).toContain('Device connected')

    const done = await poll(s)
    expect(done).toMatchObject({ status: 'approved', endpoint: origin })
    const token = done.token as string
    expect(token).toMatch(/^vbd_/)
    expect(await poll(s)).toEqual({ status: 'expired' })

    const auth = { Authorization: `Bearer ${token}` }
    expect((await fetch(`${server.base}/v1/ping`, { headers: auth })).status).toBe(200)
    expect(await (await fetch(`${server.base}/v1/me`, { headers: auth })).json()).toMatchObject({ device: { name: 'My phone' }, pairing: true })
    expect((await upload(server.base, { token })).status).toBe(201) // a device can upload
    const list = (await (await fetch(`${server.base}/v1/devices`, { headers: auth })).json()) as { devices: Array<{ name: string; current: boolean }> }
    expect(list.devices).toMatchObject([{ name: 'My phone', current: true }])
  })

  it('does not let a device token open the assistant endpoint', async () => {
    const { token } = await connect()
    const response = await fetch(`${server.base}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: '{}' })
    expect(response.status).toBe(401)
  })

  it('lets the owner deny a request', async () => {
    const s = await start()
    expect((await decide(s.userCode, '', 'deny')).status).toBe(200)
    expect(await poll(s)).toEqual({ status: 'denied' })
  })

  it('rejects an unknown or expired code with a clear page', async () => {
    const response = await decide('ABCD-EFGH', PASS)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not valid')
  })

  it('locks after repeated wrong passphrases', async () => {
    const s = await start()
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await decide(s.userCode, `wrong-${attempt}`)).status).toBe(401)
    expect((await decide(s.userCode, PASS)).status).toBe(429)
  })

  it('lets a device disconnect itself, but not others; the owner token can disconnect any', async () => {
    const phone = await connect('Phone')
    const laptop = await connect('Laptop')
    const asPhone = { Authorization: `Bearer ${phone.token}` }
    expect((await fetch(`${server.base}/v1/devices/${laptop.deviceId}`, { method: 'DELETE', headers: asPhone })).status).toBe(403)
    expect((await fetch(`${server.base}/v1/ping`, { headers: { Authorization: `Bearer ${laptop.token}` } })).status).toBe(200)
    expect((await fetch(`${server.base}/v1/devices/${phone.deviceId}`, { method: 'DELETE', headers: asPhone })).status).toBe(204)
    expect((await fetch(`${server.base}/v1/ping`, { headers: asPhone })).status).toBe(401) // cut off at once
    expect((await fetch(`${server.base}/v1/devices/${laptop.deviceId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${INGEST}` } })).status).toBe(204)
    expect((await fetch(`${server.base}/v1/ping`, { headers: { Authorization: `Bearer ${laptop.token}` } })).status).toBe(401)
    expect((await fetch(`${server.base}/v1/devices/${laptop.deviceId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${INGEST}` } })).status).toBe(404)
  })

  it('still accepts the original upload token, which is the owner\'s', async () => {
    expect(await (await fetch(`${server.base}/v1/me`, { headers: { Authorization: `Bearer ${INGEST}` } })).json()).toMatchObject({ device: null })
    expect((await fetch(`${server.base}/v1/ping`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${server.base}/v1/ping`, { headers: { Authorization: 'Bearer vbd_nope' } })).status).toBe(401)
  })

  it('can be called from the app in the browser', async () => {
    const response = await fetch(`${server.base}/v1/pair/start`, { method: 'OPTIONS', headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'POST' } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('survives a garbage body when asking to pair', async () => {
    const response = await fetch(`${server.base}/v1/pair/start`, { method: 'POST', headers: json, body: JSON.stringify({ deviceName: 42 }) })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { userCode: string }).userCode).toMatch(CODE)
    expect((await fetch(`${server.base}/v1/pair/start`, { method: 'POST', headers: json, body: '{nope' })).status).toBe(400)
  })
})

describe('pairing when the server is not set up for it', () => {
  it('says so, so the app can offer the manual way instead', async () => {
    const dir = await tempDir()
    const server = await run(testConfig(dir.dir, { workerEnabled: false }))
    try {
      const start = await fetch(`${server.base}/v1/pair/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect(start.status).toBe(501)
      expect(((await start.json()) as { error: string }).error).toMatch(/OWNER_PASSPHRASE and PUBLIC_URL/)
      expect((await fetch(`${server.base}/pair`)).status).toBe(404)
      expect(await (await fetch(`${server.base}/v1/me`, { headers: { Authorization: `Bearer ${INGEST}` } })).json()).toMatchObject({ pairing: false })
    } finally { await server.stop(); await dir.clean() }
  })
})
