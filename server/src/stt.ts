import { readFile } from 'node:fs/promises'
import type { Config } from './config.ts'
import type { Segment, Transcript } from './types.ts'
import { PermanentError, errorText, withKeys } from './util.ts'

type Stt = NonNullable<Config['stt']>
export type Fetch = typeof fetch

const FILLER_ONLY = /^(?:thank you|thanks for watching|thanks|you|bye|okay|\.|,|\s)*$/i

interface VerboseResponse {
  text?: string
  model?: string
  language?: string
  duration?: number
  segments?: Array<{ start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }>
}

const classify = (status: number, message: string) => (status === 408 || status === 425 || status === 429 || status >= 500 ? new Error(message) : new PermanentError(message))

/**
 * Turns a recording into words, with any OpenAI-compatible `/audio/transcriptions` server (in practice the faster-whisper
 * server that runs next to this one, so the audio never leaves the machine). The text is kept word for word, with timed
 * segments when the server provides them.
 */
export async function transcribe(config: Stt, audioPath: string, mime: string, fetchImpl: Fetch = fetch): Promise<Transcript> {
  return transcribeBytes(config, await readFile(audioPath), audioPath.split('/').pop() ?? 'audio.webm', mime, fetchImpl)
}

/** The same, for audio that is already in memory (the pipeline gets it from storage, which may not be a local file). */
export async function transcribeBytes(config: Stt, audio: Uint8Array, filename: string, mime: string, fetchImpl: Fetch = fetch): Promise<Transcript> {
  if (audio.byteLength > config.maxMb * 1024 * 1024) {
    throw new PermanentError(`The recording is ${(audio.byteLength / 1048576).toFixed(0)} MB, over the ${config.maxMb} MB limit for this transcription service. Use a local transcriber or raise STT_MAX_MB.`)
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0] || 'audio/webm' }), filename)
  form.append('model', config.model)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  form.append('temperature', '0')
  if (config.language) form.append('language', config.language)
  if (config.prompt) form.append('prompt', config.prompt)

  let response: Response
  try {
    response = await withKeys(config.apiKey, key => fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: AbortSignal.timeout(15 * 60_000),
    }))
  } catch (error) {
    throw new Error(`Transcription service unreachable: ${errorText(error)}`)
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw classify(response.status, `Transcription service answered ${response.status}. ${detail}`.trim())
  }

  const data = (await response.json()) as VerboseResponse
  const segments: Segment[] = (data.segments ?? [])
    // Whisper's own rule for dropping segments it invented over silence.
    .filter(segment => !((segment.no_speech_prob ?? 0) > 0.6 && (segment.avg_logprob ?? 0) < -1))
    .map(segment => ({ start: Number(segment.start), end: Number(segment.end), text: String(segment.text).trim() }))
    .filter(segment => segment.text)
  const body = (segments.length ? segments.map(segment => segment.text).join(' ') : String(data.text ?? '')).trim()
  return {
    text: body,
    language: data.language ?? null,
    durationSec: typeof data.duration === 'number' ? data.duration : null,
    // A self-hosted server reports the model it really loaded, which is what the note should say it was transcribed by.
    model: typeof data.model === 'string' && data.model ? data.model : config.model,
    segments,
    suspectedSilence: body.length === 0 || FILLER_ONLY.test(body),
    createdAt: new Date().toISOString(),
  }
}
