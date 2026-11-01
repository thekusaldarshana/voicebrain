import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNet } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.ts'
import { createApp, type App, type AuthOptions } from '../src/app.ts'

export const INGEST = 'test-ingest-token-123'
export const NOTE_ID = '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b'
export const TRANSCRIPT = 'Remind me to call the bank tomorrow. I also had an idea about the Trapper app. Maybe a weekly review screen.'
// 2026-10-30 09:12 in Colombo (UTC+5:30)
export const CREATED_AT = '2026-10-30T03:42:00.000Z'

export async function tempDir(): Promise<{ dir: string; clean: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'voicebrain-'))
  return { dir, clean: () => rm(dir, { recursive: true, force: true }) }
}

export function testConfig(dir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0, host: '127.0.0.1', dataDir: dir, publicUrl: '', ingestToken: INGEST, mcpToken: '', ownerPassphrase: '', googleClientId: '', googleClientSecret: '', allowedEmails: [], driveEnabled: false, tokenEncryptionKey: '', allowedOrigin: '*',
    ownerTimezone: 'Asia/Colombo', stt: null, llm: null, workerEnabled: true, workerIntervalMs: 40, maxAttempts: 4, gitEnabled: true, insecure: false,
    ...overrides,
  }
}

const handedOut = new Set<number>()

/**
 * A port nobody is listening on. Random and below the range the OS uses for outgoing connections, and never the
 * same one twice in a process: a recycled port lets undici reuse a keep-alive socket that belonged to the previous
 * (closed) test server, which shows up as "other side closed".
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000)
    if (handedOut.has(port)) continue
    const free = await new Promise<boolean>(resolve => {
      const probe = createNet()
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    if (free) { handedOut.add(port); return port }
  }
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export interface Fake { url: string; requests: Array<{ path: string; fields: Record<string, string>; json?: any }>; close: () => Promise<void>; respond: (handler: (index: number) => FakeReply | null) => void }
export type FakeReply = { status?: number; body: unknown; delayMs?: number }

async function fake(handle: (request: IncomingMessage, raw: Buffer, record: Fake['requests'][number], index: number) => Promise<FakeReply>): Promise<Fake> {
  const requests: Fake['requests'] = []
  let override: ((index: number) => FakeReply | null) | null = null
  const server: Server = createServer(async (request, response) => {
    const raw = await body(request)
    const record: Fake['requests'][number] = { path: request.url ?? '', fields: {} }
    requests.push(record)
    const index = requests.length - 1
    const reply = override?.(index) ?? (await handle(request, raw, record, index))
    if (reply.delayMs) await new Promise(done => setTimeout(done, reply.delayMs))
    response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' })
    response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    respond: handler => { override = handler },
    close: () => new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()) }),
  }
}

/** An OpenAI-compatible transcription server that returns `text` with three timed segments. */
export function fakeStt(text = TRANSCRIPT): Promise<Fake> {
  return fake(async (request, raw, record) => {
    const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': request.headers['content-type'] ?? '' }, body: raw }).formData()
    for (const [key, value] of form.entries()) record.fields[key] = typeof value === 'string' ? value : `file:${value.size}`
    const sentences = text.split(/(?<=[.!?])\s+/)
    return { body: { text, language: 'english', duration: sentences.length * 3.5, segments: sentences.map((sentence, index) => ({ start: index * 3.5, end: index * 3.5 + 3, text: ` ${sentence}`, no_speech_prob: 0.01, avg_logprob: -0.2 })) } }
  })
}

export const DIGEST = {
  title: 'Bank call and weekly review idea',
  summary: 'Needs to call the bank tomorrow. Thought of a weekly review screen for Trapper.',
  tasks: [
    { text: 'Call the bank', due: '2026-10-31', project: null, priority: 'normal', quote: 'Remind me to call the bank tomorrow' },
    { text: 'Book a dentist appointment', due: null, project: null, priority: 'normal', quote: 'I must book the dentist for next week' },
  ],
  ideas: [{ text: 'Add a weekly review screen to Trapper', quote: 'Maybe a weekly review screen' }],
  decisions: [], questions: [],
  people: [{ name: 'Nimal', context: 'mentioned once' }],
  projects: [{ name: 'Trapper', context: 'wants a weekly review screen' }],
  tags: ['bank', 'trapper'],
}

/** An OpenAI-compatible chat server that answers every request with DIGEST (one task is invented on purpose). */
export function fakeLlm(reply: unknown = DIGEST): Promise<Fake> {
  return fake(async (_request, raw, record) => {
    record.json = JSON.parse(raw.toString('utf8'))
    return { body: { choices: [{ message: { role: 'assistant', content: JSON.stringify(reply) } }] } }
  })
}

export async function upload(base: string, options: { id?: string; token?: string; mime?: string; createdAt?: string; marks?: number[]; audio?: Uint8Array<ArrayBuffer>; extra?: Record<string, unknown>; key?: string | null } = {}) {
  const id = options.id ?? NOTE_ID
  const form = new FormData()
  form.append('meta', JSON.stringify({ id, createdAt: options.createdAt ?? CREATED_AT, durationMs: 10_500, mime: options.mime ?? 'audio/webm;codecs=opus', size: 4, title: '', tags: ['inbox'], marks: options.marks ?? [8000], recovered: false, source: 'record', device: 'Pixel', timezone: 'Asia/Colombo', utcOffsetMinutes: 330, app: 'trapper-voice/0.1.0', ...options.extra }))
  form.append('audio', new Blob([options.audio ?? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], { type: 'audio/webm' }), `${id}.webm`)
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token ?? INGEST}` }
  if (options.key !== null) headers['Idempotency-Key'] = options.key ?? id
  return fetch(`${base}/v1/notes`, { method: 'POST', headers, body: form })
}

export async function waitFor<T>(check: () => T | Promise<T>, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(done => setTimeout(done, 25))
  }
}

export interface Running { app: App; base: string; stop: () => Promise<void> }

export async function run(config: Config, fetchImpl: typeof fetch = fetch, auth: AuthOptions = {}): Promise<Running> {
  const app = createApp(config, { fetch: fetchImpl, retryDelay: () => 30, log: () => undefined }, auth)
  await app.start()
  const port = await app.listen(config.port)
  return { app, base: `http://127.0.0.1:${port}`, stop: () => app.close() }
}

