import { join, resolve } from 'node:path'

export interface ProviderConfig { baseUrl: string; apiKey: string; model: string }

export interface Config {
  port: number
  host: string
  dataDir: string
  /** Public https address, used for OAuth. Example: https://brain.example.com */
  publicUrl: string
  ingestToken: string
  mcpToken: string
  ownerPassphrase: string
  allowedOrigin: string
  /** IANA zone used for "today" and for notes written in chat. Example: Asia/Colombo */
  ownerTimezone: string
  stt: (ProviderConfig & { language: string; maxMb: number; prompt: string }) | null
  llm: (ProviderConfig & { maxInputChars: number }) | null
  workerEnabled: boolean
  workerIntervalMs: number
  maxAttempts: number
  gitEnabled: boolean
  insecure: boolean
}

const text = (value: string | undefined, fallback = '') => (value ?? fallback).trim()
const trimSlash = (value: string) => value.replace(/\/+$/, '')

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const insecure = env.INSECURE === '1'
  const ingestToken = text(env.INGEST_TOKEN)
  if (!insecure && ingestToken.length < 16) throw new Error('Set INGEST_TOKEN to a random string of at least 16 characters (or INSECURE=1 for local testing).')
  const ownerPassphrase = text(env.OWNER_PASSPHRASE)
  if (ownerPassphrase && ownerPassphrase.length < 12) throw new Error('OWNER_PASSPHRASE must be at least 12 characters.')
  const publicUrl = trimSlash(text(env.PUBLIC_URL))
  if (ownerPassphrase && !publicUrl) throw new Error('PUBLIC_URL is required when OWNER_PASSPHRASE is set (ChatGPT signs in through it).')

  const sttBase = trimSlash(text(env.STT_BASE_URL))
  const llmBase = trimSlash(text(env.LLM_BASE_URL))
  return {
    port: Number(env.PORT ?? 8787),
    host: text(env.HOST, '0.0.0.0'),
    dataDir: resolve(text(env.DATA_DIR, join(process.cwd(), 'data'))),
    publicUrl,
    ingestToken,
    mcpToken: text(env.MCP_TOKEN),
    ownerPassphrase,
    allowedOrigin: text(env.ALLOWED_ORIGIN, '*'),
    ownerTimezone: text(env.OWNER_TIMEZONE, 'UTC'),
    stt: sttBase ? { baseUrl: sttBase, apiKey: text(env.STT_API_KEY), model: text(env.STT_MODEL, 'whisper-1'), language: text(env.STT_LANGUAGE, 'en'), maxMb: Number(env.STT_MAX_MB ?? 24), prompt: text(env.STT_PROMPT) } : null,
    llm: llmBase ? { baseUrl: llmBase, apiKey: text(env.LLM_API_KEY), model: text(env.LLM_MODEL), maxInputChars: Number(env.LLM_MAX_INPUT_CHARS ?? 20_000) } : null,
    workerEnabled: env.WORKER !== '0',
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 5000),
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 8),
    gitEnabled: env.GIT !== '0',
    insecure,
  }
}
