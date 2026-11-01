import { PairingUnavailable, ServerError, pollPairing, startPairing, type PairPoll, type PairStart } from './server'
import { normalizeEndpoint } from './endpoint'
import { errorMessage } from './errors'

export type ConnectState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; code: string; url: string; expiresAt: number }
  | { phase: 'failed'; reason: 'denied' | 'expired' | 'unavailable' | 'network'; message: string }

export interface Connected { endpoint: string; token: string; deviceId: string }

export interface ConnectDeps {
  fetchImpl?: typeof fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * Adds this device to a server. The app asks for a code, reports it so it can be shown, and then waits while the
 * owner approves it on the server's own page. Nothing is copied or pasted. Resolves with the new credentials,
 * or null if it was cancelled or failed (the reason is reported through `onState`).
 */
export async function connectDevice(endpoint: string, deviceName: string, onState: (state: ConnectState) => void, signal: AbortSignal, deps: ConnectDeps = {}): Promise<Connected | null> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  const fail = (reason: 'denied' | 'expired' | 'unavailable' | 'network', message: string) => { onState({ phase: 'failed', reason, message }); return null }

  onState({ phase: 'starting' })
  let start: PairStart
  try {
    start = await startPairing(endpoint, deviceName, signal, fetchImpl)
  } catch (error) {
    if (signal.aborted) return null
    if (error instanceof PairingUnavailable) return fail('unavailable', 'This server cannot connect devices with one tap yet. Use the manual way under Advanced.')
    return fail('network', error instanceof ServerError ? error.message : errorMessage(error))
  }

  const expiresAt = now() + start.expiresIn * 1000
  onState({ phase: 'waiting', code: start.userCode, url: start.verificationUrl, expiresAt })

  let misses = 0
  while (!signal.aborted) {
    if (now() >= expiresAt) return fail('expired', 'The code expired. Tap Connect to get a new one.')
    let result: PairPoll
    try {
      result = await pollPairing(endpoint, start, signal, fetchImpl)
      misses = 0
    } catch (error) {
      if (signal.aborted) return null
      misses += 1 // a dropped connection for a few seconds should not lose the request
      if (misses >= 5) return fail('network', `Lost contact with the server. ${error instanceof ServerError ? error.message : errorMessage(error)}`)
      await sleep(start.interval * 1000, signal)
      continue
    }
    if (result.status === 'approved') return { endpoint: result.endpoint || normalizeEndpoint(endpoint), token: result.token, deviceId: result.deviceId }
    if (result.status === 'denied') return fail('denied', 'The request was denied on the server.')
    if (result.status === 'expired') return fail('expired', 'The code expired. Tap Connect to get a new one.')
    await sleep(start.interval * 1000, signal)
  }
  return null
}
