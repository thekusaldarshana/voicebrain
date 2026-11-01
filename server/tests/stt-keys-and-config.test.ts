import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { transcribe } from '../src/stt.ts'
import { withKeys } from '../src/util.ts'
import { TRANSCRIPT, fakeStt, type Fake } from './helpers.ts'

let dir = ''
let audio = ''
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'stt-')); audio = join(dir, 'audio.webm'); await writeFile(audio, new Uint8Array([1, 2, 3, 4, 5])) })
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('several API keys', () => {
  it('moves to the next key when one is rate limited, and starts from the next key each call', async () => {
    const seen: string[] = []
    const respond = (limited: string[]) => async (key: string) => { seen.push(key); return new Response('{}', { status: limited.includes(key) ? 429 : 200 }) }
    expect((await withKeys('a,b,c', respond(['a']))).status).toBe(200)
    expect(seen).toEqual(['a', 'b'])
    seen.length = 0
    await withKeys('a,b,c', respond([])) // starts at b
    expect(seen).toEqual(['b'])
    seen.length = 0
    expect((await withKeys('a,b,c', respond(['a', 'b', 'c']))).status).toBe(429) // all limited: report it
    expect(seen.sort()).toEqual(['a', 'b', 'c'])
    expect((await withKeys('', async key => new Response(key === '' ? 'ok' : 'x'))).status).toBe(200)
  })

  it('rotates across real requests to a transcription server', async () => {
    const server: Fake = await fakeStt()
    server.respond(index => (index === 0 ? { status: 429, body: 'slow down' } : null))
    const transcript = await transcribe({ provider: 'openai', baseUrl: server.url, apiKey: 'k1, k2', model: 'm', language: 'en', maxMb: 24, prompt: '' }, audio, 'audio/webm')
    await server.close()
    expect(transcript.text).toBe(TRANSCRIPT)
    expect(server.requests).toHaveLength(2)
  })
})

describe('choosing the transcriber from the environment', () => {
  const env = { INSECURE: '1' }
  it('is an OpenAI-compatible Whisper server', () => { expect(loadConfig({ ...env, STT_BASE_URL: 'http://stt:8000/v1/' }).stt).toMatchObject({ provider: 'openai', baseUrl: 'http://stt:8000/v1', model: 'whisper-1', maxMb: 24 }) })
  it('is off when nothing is set', () => { expect(loadConfig(env).stt).toBeNull() })
  it('refuses Gemini, with a clear message, instead of quietly sending audio to Google', () => {
    expect(() => loadConfig({ ...env, STT_PROVIDER: 'gemini' })).toThrow(/Whisper server/)
    expect(() => loadConfig({ ...env, STT_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta' })).toThrow(/Gemini transcription was removed/)
  })
})
