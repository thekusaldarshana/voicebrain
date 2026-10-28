/** Upload rules. public/sw.js carries a copy; tests/sw-parity.test.ts keeps the two identical. */
export type Outcome = 'ok' | 'retry' | 'permanent'

export function classifyStatus(status: number): Outcome {
  if (status >= 200 && status < 300) return 'ok'
  // 409 means the server already holds this note id, which is what we wanted.
  if (status === 409) return 'ok'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry'
  return 'permanent'
}

export function retryDelayMs(attempts: number, random: () => number = Math.random, retryAfterSeconds = 0): number {
  const base = Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1))
  const delay = Math.round(base * (0.8 + random() * 0.4))
  return retryAfterSeconds > 0 ? Math.max(delay, Math.min(retryAfterSeconds, 3600) * 1000) : delay
}

export function uploadTimeoutMs(size: number): number {
  return Math.min(15 * 60_000, 60_000 + Math.ceil(size / 50_000) * 1000)
}

export function statusMessage(status: number): string {
  if (status === 401 || status === 403) return 'The server rejected the access token.'
  if (status === 404) return 'The upload address was not found on the server.'
  if (status === 413) return 'The server says this recording is too large.'
  if (status === 415 || status === 422) return 'The server could not accept this audio format.'
  if (status === 429) return 'The server asked us to slow down.'
  if (status >= 500) return `The server had a problem (${status}).`
  return `The server answered ${status}.`
}
