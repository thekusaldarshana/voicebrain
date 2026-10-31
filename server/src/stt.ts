import { readFile } from 'node:fs/promises'
import type { Config } from './config.ts'
import type { Segment, Transcript } from './types.ts'
import { PermanentError, errorText, withKeys } from './util.ts'

type Stt = NonNullable<Config['stt']>
export type Fetch = typeof fetch

const FILLER_ONLY = /^(?:thank you|thanks for watching|thanks|you|bye|okay|\.|,|\s)*$/i

interface VerboseResponse {
  text?: string
  language?: string
  duration?: number
  segments?: Array<{ start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }>
}

const secondsOf = (hours: string | undefined, minutes: string, seconds: string) => (hours === undefined ? 0 : Number(hours) * 3600) + Number(minutes) * 60 + Number(seconds)

/** Reads "[mm:ss] sentence" lines into timed segments. A segment ends where the next one starts. */
export function parseTimestamped(text: string): Segment[] {
  const segments: Segment[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]\s*(.*?)\s*$/.exec(line)
    if (!match) {
      const last = segments.at(-1)
      if (last && line.trim()) last.text += ` ${line.trim()}`
      continue
    }
    const start = secondsOf(match[1], match[2] as string, match[3] as string)
    segments.push({ start, end: start, text: match[4] ?? '' })
  }
  segments.forEach((segment, index) => {
    const next = segments[index + 1]
    segment.end = next ? Math.max(segment.start, next.start - 0.1) : segment.start + Math.max(2, segment.text.split(/\s+/).length * 0.4)
  })
  return segments.filter(segment => segment.text)
}

const classify = (status: number, message: string) => (status === 408 || status === 425 || status === 429 || status >= 500 ? new Error(message) : new PermanentError(message))

async function transcribeGemini(config: Stt, audio: Buffer, mime: string, fetchImpl: Fetch): Promise<Transcript> {
  // A dedicated transcribe model returns clean text. Any other Gemini model is asked for per-sentence timestamps.
  const timed = !/transcri/i.test(config.model)
  const hint = config.prompt ? ` Names and terms that may appear: ${config.prompt}.` : ''
  const prompt = timed
    ? `Transcribe this audio word for word. Put a [mm:ss] timestamp at the start of every sentence. Reply with only the transcript.${hint}`
    : `Transcribe this audio.${hint}`
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime.split(';')[0] || 'audio/webm', data: audio.toString('base64') } }] }] })
  let response: Response
  try {
    response = await withKeys(config.apiKey, key => fetchImpl(`${config.baseUrl}/models/${config.model}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10 * 60_000),
    }))
  } catch (error) {
    throw new Error(`Transcription service unreachable: ${errorText(error)}`)
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({})) as { error?: { message?: string } }).error?.message ?? ''
    throw classify(response.status, `Gemini answered ${response.status}. ${detail}`.trim().slice(0, 400))
  }
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean; audioTranscription?: { text?: string } }> } }> }
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const raw = parts.map(part => part.audioTranscription?.text ?? (part.thought ? '' : part.text ?? '')).join('\n').trim()
  const segments = timed ? parseTimestamped(raw) : []
  const text = (segments.length ? segments.map(segment => segment.text).join(' ') : raw.replace(/^\s*\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]\s*/gm, '')).trim()
  return {
    text, language: null, durationSec: segments.length ? Math.round(segments[segments.length - 1]!.end) : null, model: config.model, segments,
    suspectedSilence: text.length === 0 || FILLER_ONLY.test(text), createdAt: new Date().toISOString(),
  }
}

/**
 * Turns a recording into words. `openai`: any OpenAI-compatible `/audio/transcriptions` server (Groq, OpenAI,
 * a self-hosted faster-whisper server). `gemini`: Google's generateContent API. Both return text that is
 * kept word for word, with timed segments when the service provides them.
 */
export async function transcribe(config: Stt, audioPath: string, mime: string, fetchImpl: Fetch = fetch): Promise<Transcript> {
  const audio = await readFile(audioPath)
  if (audio.byteLength > config.maxMb * 1024 * 1024) {
    throw new PermanentError(`The recording is ${(audio.byteLength / 1048576).toFixed(0)} MB, over the ${config.maxMb} MB limit for this transcription service. Use a local transcriber or raise STT_MAX_MB.`)
  }
  if (config.provider === 'gemini') return transcribeGemini(config, audio, mime, fetchImpl)
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
    model: config.model,
    segments,
    suspectedSilence: body.length === 0 || FILLER_ONLY.test(body),
    createdAt: new Date().toISOString(),
  }
}
