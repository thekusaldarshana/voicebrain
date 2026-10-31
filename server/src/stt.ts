import { readFile } from 'node:fs/promises'
import type { Config } from './config.ts'
import type { Segment, Transcript } from './types.ts'
import { PermanentError, errorText } from './util.ts'

type Stt = NonNullable<Config['stt']>
export type Fetch = typeof fetch

const FILLER_ONLY = /^(?:thank you|thanks for watching|thanks|you|bye|okay|\.|,|\s)*$/i

interface VerboseResponse {
  text?: string
  language?: string
  duration?: number
  segments?: Array<{ start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }>
}

/**
 * Any OpenAI-compatible `/audio/transcriptions` server: Groq, OpenAI, or a self-hosted faster-whisper
 * server (Speaches) on your own VPS. Returns timestamped segments so marked moments can be located.
 */
export async function transcribe(config: Stt, audioPath: string, mime: string, fetchImpl: Fetch = fetch): Promise<Transcript> {
  const audio = await readFile(audioPath)
  if (audio.byteLength > config.maxMb * 1024 * 1024) {
    throw new PermanentError(`The recording is ${(audio.byteLength / 1048576).toFixed(0)} MB, over the ${config.maxMb} MB limit for this transcription service. Use a local transcriber or raise STT_MAX_MB.`)
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0] || 'audio/webm' }), audioPath.split('/').pop() ?? 'audio.webm')
  form.append('model', config.model)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  form.append('temperature', '0')
  if (config.language) form.append('language', config.language)
  if (config.prompt) form.append('prompt', config.prompt)

  let response: Response
  try {
    response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(15 * 60_000),
    })
  } catch (error) {
    throw new Error(`Transcription service unreachable: ${errorText(error)}`)
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    const message = `Transcription service answered ${response.status}. ${detail}`.trim()
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) throw new Error(message)
    throw new PermanentError(message)
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
    model: config.model,
    segments,
    suspectedSilence: body.length === 0 || FILLER_ONLY.test(body),
    createdAt: new Date().toISOString(),
  }
}
