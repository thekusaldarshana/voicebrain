import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { parseTimestamped, transcribe } from '../src/stt.ts'
import { PermanentError, withKeys } from '../src/util.ts'
import { TRANSCRIPT, fakeGemini, fakeStt, type Fake } from './helpers.ts'

let dir = ''
let audio = ''
const bytes = new Uint8Array([1, 2, 3, 4, 5])
const gemini = (url: string, extra: Record<string, unknown> = {}) => ({ provider: 'gemini' as const, baseUrl: url, apiKey: 'key-one', model: 'gemini-3.5-transcribe', language: 'en', maxMb: 14, prompt: '', ...extra })

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'gem-')); audio = join(dir, 'audio.webm'); await writeFile(audio, bytes) })
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('Gemini transcription', () => {
  it('sends the audio inline to a transcribe model and reads its transcript', async () => {
    const server = await fakeGemini()
    const transcript = await transcribe(gemini(server.url), audio, 'audio/webm;codecs=opus')
    await server.close()
    expect(transcript).toMatchObject({ text: TRANSCRIPT, model: 'gemini-3.5-transcribe', segments: [], suspectedSilence: false })
    const request = server.requests[0]
    expect(request?.path).toBe('/models/gemini-3.5-transcribe:generateContent')
    expect(request?.fields['x-goog-api-key']).toBe('key-one')
    const parts = request?.json.contents[0].parts
    expect(parts[0].text).toBe('Transcribe this audio.')
    expect(parts[1].inline_data).toEqual({ mime_type: 'audio/webm', data: Buffer.from(bytes).toString('base64') })
  })

  it('asks other models for timestamps and turns them into segments', async () => {
    const server = await fakeGemini([{ thought: true, text: 'thinking…' }, { text: '[00:00] So measure with a ruler.\n[00:04] One step up multiplies by the twelfth root of two.\nIt keeps going on a second line.\n[00:09] Slide the pair along.' }])
    const transcript = await transcribe(gemini(server.url, { model: 'gemini-3.5-flash-lite', prompt: 'Trapper' }), audio, 'audio/webm')
    await server.close()
    expect(server.requests[0]?.json.contents[0].parts[0].text).toMatch(/\[mm:ss\] timestamp.*Trapper/s)
    expect(transcript.segments.map(segment => [segment.start, segment.text])).toEqual([[0, 'So measure with a ruler.'], [4, 'One step up multiplies by the twelfth root of two. It keeps going on a second line.'], [9, 'Slide the pair along.']])
    expect(transcript.segments[0]?.end).toBeCloseTo(3.9)
    expect(transcript.text).toBe('So measure with a ruler. One step up multiplies by the twelfth root of two. It keeps going on a second line. Slide the pair along.')
    expect(transcript.text).not.toContain('thinking')
  })

  it('keeps plain text when a model ignores the timestamp request', async () => {
    const server = await fakeGemini([{ text: 'Just words, no stamps.' }])
    const transcript = await transcribe(gemini(server.url, { model: 'gemini-3.5-flash-lite' }), audio, 'audio/webm')
    await server.close()
    expect(transcript).toMatchObject({ text: 'Just words, no stamps.', segments: [] })
  })

  it('flags filler-only and empty results', async () => {
    for (const text of ['Thank you.', '']) {
      const server = await fakeGemini([{ audioTranscription: { text } }])
      expect((await transcribe(gemini(server.url), audio, 'audio/webm')).suspectedSilence).toBe(true)
      await server.close()
    }
  })

  it('treats bad keys and missing models as permanent, rate limits as retryable', async () => {
    const server = await fakeGemini()
    for (const [status, permanent] of [[400, true], [403, true], [404, true], [429, false], [503, false]] as const) {
      server.respond(() => ({ status, body: { error: { message: 'nope' } } }))
      const error = await transcribe(gemini(server.url), audio, 'audio/webm').catch((caught: Error) => caught)
      expect(error instanceof PermanentError, String(status)).toBe(permanent)
      expect((error as Error).message).toContain(String(status))
    }
    await server.close()
  })

  it('refuses audio too big to send inline', async () => {
    await expect(transcribe(gemini('http://x', { maxMb: 0.000001 }), audio, 'audio/webm')).rejects.toThrow(/over the .* limit/)
  })
})

describe('reading timestamps', () => {
  it('handles hours, ends, and stray lines', () => {
    const segments = parseTimestamped('[01:02:03] Late.\n[1:05] Earlier format.\nno stamp here\n[00:07]   \n')
    expect(segments.map(segment => [segment.start, segment.text])).toEqual([[3723, 'Late.'], [65, 'Earlier format. no stamp here']])
    expect(parseTimestamped('nothing stamped')).toEqual([])
  })
})

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

describe('choosing a provider from the environment', () => {
  const env = { INSECURE: '1' }
  it('defaults to OpenAI-compatible', () => { expect(loadConfig({ ...env, STT_BASE_URL: 'https://api.groq.com/openai/v1/' }).stt).toMatchObject({ provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-1', maxMb: 24 }) })
  it('uses Gemini defaults when only the provider is named', () => { expect(loadConfig({ ...env, STT_PROVIDER: 'gemini', STT_API_KEY: 'a,b' }).stt).toMatchObject({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-transcribe', maxMb: 14, apiKey: 'a,b' }) })
  it('recognizes a Gemini address', () => { expect(loadConfig({ ...env, STT_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta' }).stt?.provider).toBe('gemini') })
  it('leaves transcription off when nothing is set', () => { expect(loadConfig(env).stt).toBeNull() })
})
