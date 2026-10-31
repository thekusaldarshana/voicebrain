import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NOTE_ID, run, tempDir, testConfig, upload, type Running } from './helpers.ts'

let dir: Awaited<ReturnType<typeof tempDir>>
let server: Running

beforeAll(async () => { dir = await tempDir(); server = await run(testConfig(dir.dir, { workerEnabled: false })) })
afterAll(async () => { await server.stop(); await dir.clean() })

describe('the upload contract the recorder app relies on', () => {
  it('answers health without a token, and ping only with the right one', async () => {
    expect((await fetch(`${server.base}/health`)).status).toBe(200)
    expect((await fetch(`${server.base}/v1/ping`)).status).toBe(401)
    expect((await fetch(`${server.base}/v1/ping`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await fetch(`${server.base}/v1/ping`, { headers: { Authorization: 'Bearer test-ingest-token-123' } })).status).toBe(200)
  })

  it('allows the browser preflight from the app origin', async () => {
    const response = await fetch(`${server.base}/v1/notes`, { method: 'OPTIONS', headers: { Origin: 'https://voice.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,idempotency-key' } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toMatch(/Idempotency-Key/)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('stores the audio and what the app said about it', async () => {
    const response = await upload(server.base, { extra: { tags: ['a', 3, 'b'], title: 'Hello' } })
    expect(response.status).toBe(201)
    const meta = JSON.parse(await readFile(join(dir.dir, 'inbox', NOTE_ID, 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({ id: NOTE_ID, title: 'Hello', tags: ['a', 'b'], marks: [8000], device: 'Pixel', utcOffsetMinutes: 330, audioFile: 'audio.webm', audioBytes: 8, source: 'record' })
    expect([...(await readFile(join(dir.dir, 'inbox', NOTE_ID, 'audio.webm')))].slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  })

  it('rejects uploads without a token, with bad ids, or a mismatched key', async () => {
    expect((await fetch(`${server.base}/v1/notes`, { method: 'POST', body: new FormData() })).status).toBe(401)
    expect((await upload(server.base, { id: '../../etc/passwd', key: null })).status).toBe(422)
    expect((await upload(server.base, { id: '11111111-2222-4333-8444-555555555555', key: NOTE_ID })).status).toBe(422)
    expect((await fetch(`${server.base}/v1/notes`, { method: 'POST', headers: { Authorization: 'Bearer test-ingest-token-123' }, body: 'plain text' })).status).toBe(400)
    expect((await fetch(`${server.base}/nope`)).status).toBe(404)
  })

  it('ignores a hostile meta field instead of trusting it', async () => {
    const id = '55555555-5555-4555-8555-555555555555'
    expect((await upload(server.base, { id, extra: { createdAt: 'not a date', durationMs: 'x', marks: [-5, 'a', 12], timezone: 5, source: '../../x' } })).status).toBe(201)
    const meta = JSON.parse(await readFile(join(dir.dir, 'inbox', id, 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({ durationMs: 0, marks: [12], timezone: 'UTC', source: 'record' })
    expect(Number.isNaN(new Date(meta.createdAt).getTime())).toBe(false)
  })
})
