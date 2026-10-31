import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { transcribe } from '../src/stt.ts'
import { PermanentError } from '../src/util.ts'
import { TRANSCRIPT, fakeStt, type Fake } from './helpers.ts'

let dir = ''
let audio = ''
let stt: Fake
const config = (extra = {}) => ({ provider: 'openai' as const, baseUrl: stt.url, apiKey: 'secret', model: 'whisper-large-v3-turbo', language: 'en', maxMb: 24, prompt: 'Trapper, voicebrain', ...extra })

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stt-'))
  audio = join(dir, 'audio.webm')
  await writeFile(audio, new Uint8Array([1, 2, 3, 4, 5]))
  stt = await fakeStt()
})
afterAll(async () => { await stt.close(); await rm(dir, { recursive: true, force: true }) })

describe('transcription client', () => {
  it('sends an OpenAI-compatible request and returns timed segments', async () => {
    const transcript = await transcribe(config(), audio, 'audio/webm;codecs=opus')
    expect(transcript.text).toBe(TRANSCRIPT)
    expect(transcript.segments).toHaveLength(3)
    expect(transcript.segments[1]).toMatchObject({ start: 3.5, end: 6.5, text: 'I also had an idea about the Trapper app.' })
    expect(transcript.suspectedSilence).toBe(false)
    const sent = stt.requests.at(-1)?.fields
    expect(sent).toMatchObject({ model: 'whisper-large-v3-turbo', language: 'en', response_format: 'verbose_json', temperature: '0', prompt: 'Trapper, voicebrain', file: 'file:5' })
    expect(stt.requests.at(-1)?.path).toBe('/audio/transcriptions')
  })

  it('drops segments the model invented over silence, and flags filler-only results', async () => {
    stt.respond(() => ({ body: { text: 'Thank you.', segments: [{ start: 0, end: 2, text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.4 }] } }))
    const silent = await transcribe(config(), audio, 'audio/webm')
    expect(silent.segments).toEqual([])
    expect(silent.suspectedSilence).toBe(true)
    stt.respond(() => ({ body: { text: 'Thank you.' } }))
    const filler = await transcribe(config(), audio, 'audio/webm')
    expect(filler.text).toBe('Thank you.') // never discarded, only flagged
    expect(filler.suspectedSilence).toBe(true)
    stt.respond(() => null)
  })

  it('works with servers that return only text', async () => {
    stt.respond(() => ({ body: { text: 'Plain words here.' } }))
    const transcript = await transcribe(config(), audio, 'audio/webm')
    stt.respond(() => null)
    expect(transcript).toMatchObject({ text: 'Plain words here.', segments: [], suspectedSilence: false })
  })

  it('retries server trouble and gives up on client errors', async () => {
    stt.respond(() => ({ status: 503, body: 'busy' }))
    await expect(transcribe(config(), audio, 'audio/webm')).rejects.not.toBeInstanceOf(PermanentError)
    stt.respond(() => ({ status: 429, body: 'slow down' }))
    await expect(transcribe(config(), audio, 'audio/webm')).rejects.not.toBeInstanceOf(PermanentError)
    stt.respond(() => ({ status: 401, body: 'bad key' }))
    await expect(transcribe(config(), audio, 'audio/webm')).rejects.toBeInstanceOf(PermanentError)
    stt.respond(() => null)
  })

  it('refuses a file over the service limit instead of failing mysteriously', async () => {
    await expect(transcribe(config({ maxMb: 0.000001 }), audio, 'audio/webm')).rejects.toThrow(/over the .* limit/)
  })

  it('reports an unreachable service as retryable', async () => {
    await expect(transcribe({ ...config(), baseUrl: 'http://127.0.0.1:1' }, audio, 'audio/webm')).rejects.toThrow(/unreachable/)
  })
})
