import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM module without types
import { createReceiver } from '../server/receiver.mjs'

const token = 'test-token'
let dir = ''
let base = ''
let receiver: ReturnType<typeof createReceiver>

const noteForm = (id: string, extra: Record<string, unknown> = {}) => {
  const form = new FormData()
  form.append('meta', JSON.stringify({ id, mime: 'audio/webm;codecs=opus', title: 'Hello', ...extra }))
  form.append('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), `${id}.webm`)
  return form
}
const auth = { Authorization: `Bearer ${token}` }
const ID = '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tv-receiver-'))
  receiver = createReceiver({ token, dataDir: dir })
  base = `http://127.0.0.1:${await receiver.listen(0)}`
})
afterAll(async () => { await receiver.close(); await rm(dir, { recursive: true, force: true }) })

describe('receiver', () => {
  it('answers health without auth and ping only with the token', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect((await fetch(`${base}/v1/ping`)).status).toBe(401)
    expect((await fetch(`${base}/v1/ping`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${base}/v1/ping`, { headers: auth })).status).toBe(200)
  })
  it('allows the browser preflight', async () => {
    const response = await fetch(`${base}/v1/notes`, { method: 'OPTIONS', headers: { Origin: 'https://voice.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,idempotency-key' } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toMatch(/Idempotency-Key/)
  })
  it('stores a note once and calls the repeat a duplicate', async () => {
    const first = await fetch(`${base}/v1/notes`, { method: 'POST', headers: { ...auth, 'Idempotency-Key': ID }, body: noteForm(ID, { tags: ['a'] }) })
    expect(first.status).toBe(201)
    const again = await fetch(`${base}/v1/notes`, { method: 'POST', headers: { ...auth, 'Idempotency-Key': ID }, body: noteForm(ID) })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true })
    expect(await receiver.notes()).toEqual([ID])
    const stored = JSON.parse(await readFile(join(receiver.inbox, ID, 'meta.json'), 'utf8'))
    expect(stored).toMatchObject({ id: ID, title: 'Hello', tags: ['a'], audioFile: 'audio.webm', audioBytes: 4 })
    expect([...(await readFile(join(receiver.inbox, ID, 'audio.webm')))]).toEqual([1, 2, 3, 4])
  })
  it('rejects uploads without a token, with bad meta, or with a mismatched key', async () => {
    expect((await fetch(`${base}/v1/notes`, { method: 'POST', body: noteForm(ID) })).status).toBe(401)
    expect((await fetch(`${base}/v1/notes`, { method: 'POST', headers: auth, body: noteForm('../../etc/passwd') })).status).toBe(422)
    const other = '11111111-2222-4333-8444-555555555555'
    expect((await fetch(`${base}/v1/notes`, { method: 'POST', headers: { ...auth, 'Idempotency-Key': ID }, body: noteForm(other) })).status).toBe(422)
    expect((await fetch(`${base}/v1/notes`, { method: 'POST', headers: auth, body: 'plain text' })).status).toBe(400)
    expect((await fetch(`${base}/nope`, { headers: auth })).status).toBe(404)
    expect(await receiver.notes()).toEqual([ID])
  })
})
