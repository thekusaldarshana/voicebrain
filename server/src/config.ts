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
  /** Per-user Google Drive connections are on. Needs Google sign-in and TOKEN_ENCRYPTION_KEY. */
  driveEnabled: boolean
  /** base64 of 32 random bytes. Encrypts the stored Drive refresh tokens. Empty = not set. */
  tokenEncryptionKey: string
  allowedOrigin: string
  /** IANA zone used for "today" and for notes written in chat. Example: Asia/Colombo */
  ownerTimezone: string
  stt: (ProviderConfig & { provider: 'openai'; language: string; maxMb: number; prompt: string }) | null
  /**
   * Optional: a model the server itself asks to sort notes into tasks and ideas, so it happens without anyone opening an
   * assistant. `openai` is any OpenAI-compatible server (OpenAI, Groq, OpenRouter, Gemini's compatible endpoint, a local
   * Ollama), `anthropic` is Anthropic's Messages API, and `cli` runs an agent command installed on this machine.
   */
  llm: (ProviderConfig & { maxInputChars: number; provider?: 'openai' | 'anthropic' | 'cli'; /** for `cli`: the program and its arguments */ command?: string[] }) | null
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

/** Agent programs that can be asked to sort a note. Each reads the prompt from stdin unless an argument is `{prompt}`. */
export const CLI_PRESETS: Record<string, string[]> = {
  'claude-code': ['claude', '-p'],
  codex: ['codex', 'exec', '-'],
  opencode: ['opencode', 'run', '{prompt}'],
}

/** Splits `claude -p --model "x y"` into arguments. No shell is involved, so nothing in it is ever interpreted. */
export function splitCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3] ?? '')
}

function readLlm(env: Record<string, string | undefined>): Config['llm'] {
  const provider = text(env.LLM_PROVIDER).toLowerCase()
  const maxInputChars = Number(env.LLM_MAX_INPUT_CHARS ?? 20_000)
  const known = ['openai', 'anthropic', 'cli', ...Object.keys(CLI_PRESETS)]
  if (provider && !known.includes(provider)) throw new Error(`LLM_PROVIDER "${provider}" is not one of: ${known.join(', ')}.`)
  if (provider === 'cli' || provider in CLI_PRESETS) {
    const command = text(env.LLM_COMMAND) ? splitCommand(text(env.LLM_COMMAND)) : CLI_PRESETS[provider]
    if (!command?.length) throw new Error('LLM_PROVIDER=cli needs LLM_COMMAND, for example "claude -p".')
    return { provider: 'cli', baseUrl: '', apiKey: '', model: text(env.LLM_MODEL, provider), command, maxInputChars }
  }
  if (provider === 'anthropic') {
    if (!text(env.LLM_API_KEY)) throw new Error('LLM_PROVIDER=anthropic needs LLM_API_KEY.')
    if (!text(env.LLM_MODEL)) throw new Error('LLM_PROVIDER=anthropic needs LLM_MODEL (for example a current Claude model name).')
    return { provider: 'anthropic', baseUrl: trimSlash(text(env.LLM_BASE_URL, 'https://api.anthropic.com')), apiKey: text(env.LLM_API_KEY), model: text(env.LLM_MODEL), maxInputChars }
  }
  const base = trimSlash(text(env.LLM_BASE_URL))
  return base ? { provider: 'openai', baseUrl: base, apiKey: text(env.LLM_API_KEY), model: text(env.LLM_MODEL), maxInputChars } : null
}

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

  const tokenEncryptionKey = text(env.TOKEN_ENCRYPTION_KEY)
  // Never echo the value: it is a secret even when it is wrong.
  if (tokenEncryptionKey && !/^[A-Za-z0-9+/]{43}=?$/.test(tokenEncryptionKey)) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes in base64 (openssl rand -base64 32).')
  const driveEnabled = env.DRIVE_ENABLED === '1'
  if (driveEnabled && !tokenEncryptionKey) throw new Error('DRIVE_ENABLED=1 needs TOKEN_ENCRYPTION_KEY (openssl rand -base64 32). Drive refresh tokens are never stored unencrypted.')
  if (driveEnabled && authMode({ googleClientId, googleClientSecret, ownerPassphrase }) !== 'google') throw new Error('DRIVE_ENABLED=1 needs Google sign-in (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL).')

  // Speech to text is a Whisper server (OpenAI-compatible). Sending audio to a third party is not supported.
  if (text(env.STT_PROVIDER) && text(env.STT_PROVIDER) !== 'openai') throw new Error('STT_PROVIDER is no longer used: transcription is a Whisper server (STT_BASE_URL). Remove STT_PROVIDER.')
  if (text(env.STT_BASE_URL).includes('generativelanguage.googleapis.com')) throw new Error('Gemini transcription was removed. Point STT_BASE_URL at your Whisper server.')
  const sttBase = trimSlash(text(env.STT_BASE_URL))
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
    driveEnabled,
    tokenEncryptionKey,
    allowedOrigin: text(env.ALLOWED_ORIGIN, '*'),
    ownerTimezone: text(env.OWNER_TIMEZONE, 'UTC'),
    stt: sttBase ? { provider: 'openai', baseUrl: sttBase, apiKey: text(env.STT_API_KEY), model: text(env.STT_MODEL, 'whisper-1'), language: text(env.STT_LANGUAGE, 'en'), maxMb: Number(env.STT_MAX_MB ?? 24), prompt: text(env.STT_PROMPT) } : null,
    llm: readLlm(env),
    workerEnabled: env.WORKER !== '0',
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 5000),
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 8),
    gitEnabled: env.GIT !== '0',
    insecure,
  }
}

// ---- where notes are stored (separate from the rest of the config on purpose, so it merges cleanly) ----

export type StorageConfig =
  /** `local` keeps notes as files under DATA_DIR/inbox. */
  | { backend: 'local' }
  /** `drive` keeps them in each user's own Google Drive (the `drive.file` scope). `retainAudio` is DRIVE_RETAIN_AUDIO. */
  | { backend: 'drive'; retainAudio: 'keep' | 'drop-after-digest' }

export function loadStorageConfig(env: Record<string, string | undefined> = process.env): StorageConfig {
  const backend = (env.STORAGE_BACKEND ?? '').trim() || 'local'
  if (backend === 'local') return { backend }
  if (backend === 'drive') {
    const retainAudio = (env.DRIVE_RETAIN_AUDIO ?? '').trim() || 'keep'
    if (retainAudio !== 'keep' && retainAudio !== 'drop-after-digest') throw new Error('DRIVE_RETAIN_AUDIO must be "keep" or "drop-after-digest".')
    return { backend, retainAudio }
  }
  throw new Error(`STORAGE_BACKEND "${backend}" is not available. Use "local" or "drive".`)
}
