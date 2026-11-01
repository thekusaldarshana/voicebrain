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
  /** Legacy sign-in. Only used when Google sign-in is not configured. */
  ownerPassphrase: string
  /** Google OIDC client (Google Cloud Console, "Web application"). Both empty = Google sign-in is off. */
  googleClientId: string
  googleClientSecret: string
  /** Lower-case emails allowed to sign in. Empty = the first user to sign in claims the instance. */
  allowedEmails: string[]
  allowedOrigin: string
  /** IANA zone used for "today" and for notes written in chat. Example: Asia/Colombo */
  ownerTimezone: string
  stt: (ProviderConfig & { provider: 'openai' | 'gemini'; language: string; maxMb: number; prompt: string }) | null
  llm: (ProviderConfig & { maxInputChars: number }) | null
  workerEnabled: boolean
  workerIntervalMs: number
  maxAttempts: number
  gitEnabled: boolean
  insecure: boolean
}

/** How people prove who they are: Google, the legacy passphrase, or not at all (static tokens only). */
export const authMode = (config: Pick<Config, 'googleClientId' | 'googleClientSecret' | 'ownerPassphrase'>): 'google' | 'passphrase' | 'none' =>
  config.googleClientId && config.googleClientSecret ? 'google' : config.ownerPassphrase ? 'passphrase' : 'none'

const text = (value: string | undefined, fallback = '') => (value ?? fallback).trim()
const trimSlash = (value: string) => value.replace(/\/+$/, '')

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const insecure = env.INSECURE === '1'
  const ingestToken = text(env.INGEST_TOKEN)
  if (!insecure && ingestToken.length < 16) throw new Error('Set INGEST_TOKEN to a random string of at least 16 characters (or INSECURE=1 for local testing).')
  const ownerPassphrase = text(env.OWNER_PASSPHRASE)
  if (ownerPassphrase && ownerPassphrase.length < 12) throw new Error('OWNER_PASSPHRASE must be at least 12 characters.')
  const publicUrl = trimSlash(text(env.PUBLIC_URL))
  const googleClientId = text(env.GOOGLE_CLIENT_ID)
  const googleClientSecret = text(env.GOOGLE_CLIENT_SECRET)
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.')
  if ((ownerPassphrase || googleClientId) && !publicUrl) throw new Error('PUBLIC_URL is required when Google sign-in or OWNER_PASSPHRASE is set (sign-in and ChatGPT go through it).')
  const allowedEmails = text(env.ALLOWED_EMAILS).split(/[\s,;]+/).map(email => email.toLowerCase()).filter(Boolean)
  const badEmail = allowedEmails.find(email => !/^[^@\s]+@[^@\s]+$/.test(email))
  if (badEmail) throw new Error('ALLOWED_EMAILS must be a comma-separated list of email addresses.')

  const sttProvider = text(env.STT_PROVIDER) === 'gemini' || text(env.STT_BASE_URL).includes('generativelanguage.googleapis.com') ? 'gemini' : 'openai'
  const sttBase = trimSlash(text(env.STT_BASE_URL) || (sttProvider === 'gemini' && env.STT_PROVIDER ? 'https://generativelanguage.googleapis.com/v1beta' : ''))
  const llmBase = trimSlash(text(env.LLM_BASE_URL))
  return {
    port: Number(env.PORT ?? 8787),
    host: text(env.HOST, '0.0.0.0'),
    dataDir: resolve(text(env.DATA_DIR, join(process.cwd(), 'data'))),
    publicUrl,
    ingestToken,
    mcpToken: text(env.MCP_TOKEN),
    ownerPassphrase,
    googleClientId,
    googleClientSecret,
    allowedEmails,
    allowedOrigin: text(env.ALLOWED_ORIGIN, '*'),
    ownerTimezone: text(env.OWNER_TIMEZONE, 'UTC'),
    stt: sttBase ? { provider: sttProvider, baseUrl: sttBase, apiKey: text(env.STT_API_KEY), model: text(env.STT_MODEL, sttProvider === 'gemini' ? 'gemini-3.5-transcribe' : 'whisper-1'), language: text(env.STT_LANGUAGE, 'en'), maxMb: Number(env.STT_MAX_MB ?? (sttProvider === 'gemini' ? 14 : 24)), prompt: text(env.STT_PROMPT) } : null,
    llm: llmBase ? { baseUrl: llmBase, apiKey: text(env.LLM_API_KEY), model: text(env.LLM_MODEL), maxInputChars: Number(env.LLM_MAX_INPUT_CHARS ?? 20_000) } : null,
    workerEnabled: env.WORKER !== '0',
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 5000),
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 8),
    gitEnabled: env.GIT !== '0',
    insecure,
  }
}

// ---- where notes are stored (separate from the rest of the config on purpose, so it merges cleanly) ----

export interface StorageConfig {
  /** `local` keeps notes as files under DATA_DIR/inbox. */
  backend: 'local'
}

export function loadStorageConfig(env: Record<string, string | undefined> = process.env): StorageConfig {
  const backend = (env.STORAGE_BACKEND ?? '').trim() || 'local'
  if (backend !== 'local') throw new Error(`STORAGE_BACKEND "${backend}" is not available. The only backend is "local".`)
  return { backend }
}
