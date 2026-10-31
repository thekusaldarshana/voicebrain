import type { Request, Response } from 'express'
import { Readable } from 'node:stream'
import type { Config } from './config.ts'
import type { Store } from './store.ts'
import type { NoteMeta } from './types.ts'
import { UUID } from './util.ts'

const EXTENSIONS: Record<string, string> = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac' }
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** `POST /v1/notes`: multipart `meta` (JSON) + `audio`. 201 stored, 409 already had it. */
export async function handleIngest(request: Request, response: Response, store: Store, _config: Config): Promise<NoteMeta | null> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > MAX_BYTES) { response.status(413).json({ error: 'too large' }); return null }

  let received = 0
  const body = Readable.toWeb(request).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength
      if (received > MAX_BYTES) controller.error(new Error('too large'))
      else controller.enqueue(chunk)
    },
  }))

  let form: FormData
  try {
    form = await new Request('http://ingest.local/', { method: 'POST', headers: { 'content-type': request.headers['content-type'] ?? '' }, body, duplex: 'half' } as RequestInit).formData()
  } catch (error) {
    response.status(error instanceof Error && error.message === 'too large' ? 413 : 400).json({ error: 'unreadable upload' })
    return null
  }

  let raw: Record<string, unknown>
  try { raw = JSON.parse(String(form.get('meta') ?? '')) as Record<string, unknown> } catch { response.status(422).json({ error: 'meta is not JSON' }); return null }
  const audio = form.get('audio')
  const id = raw && typeof raw.id === 'string' ? raw.id : ''
  if (!UUID.test(id) || !audio || typeof audio === 'string') { response.status(422).json({ error: 'meta.id and audio are required' }); return null }
  const key = request.headers['idempotency-key']
  if (key && key !== id) { response.status(422).json({ error: 'Idempotency-Key must equal meta.id' }); return null }

  const mime = text(raw.mime, 100) || audio.type
  const created = new Date(text(raw.createdAt, 40))
  const meta: NoteMeta = {
    id,
    createdAt: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
    durationMs: numberOr(raw.durationMs, 0),
    mime,
    size: numberOr(raw.size, audio.size),
    title: text(raw.title, 140),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12).map(tag => tag.slice(0, 40)) : [],
    marks: Array.isArray(raw.marks) ? raw.marks.filter((mark): mark is number => typeof mark === 'number' && mark >= 0).slice(0, 500) : [],
    recovered: raw.recovered === true,
    source: raw.source === 'import' ? 'import' : 'record',
    device: text(raw.device, 60),
    timezone: text(raw.timezone, 60) || 'UTC',
    utcOffsetMinutes: numberOr(raw.utcOffsetMinutes, 0),
    app: text(raw.app, 60),
    receivedAt: new Date().toISOString(),
    audioFile: null,
    audioBytes: 0,
  }
  const extension = EXTENSIONS[mime.split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'bin'
  const stored = await store.saveUpload(meta, new Uint8Array(await audio.arrayBuffer()), extension)
  if (!stored) { response.status(409).json({ ok: true, id, duplicate: true }); return null }
  response.status(201).json({ ok: true, id })
  return meta
}
