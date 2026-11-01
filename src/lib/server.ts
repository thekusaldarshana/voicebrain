import { normalizeEndpoint } from './endpoint'
import { errorMessage } from './errors'
import type { Settings } from './types'

type Fetch = typeof fetch
type Credentials = Pick<Settings, 'endpoint' | 'token'>

/** A problem talking to the server, worded for the person using the app. */
export class ServerError extends Error {
  readonly status: number
  constructor(message: string, status = 0) { super(message); this.status = status }
}

export function authHeaders(settings: Pick<Settings, 'token'>): Record<string, string> {
  return settings.token ? { Authorization: `Bearer ${settings.token}` } : {}
}

async function call(settings: Credentials, path: string, init: RequestInit, fetchImpl: Fetch): Promise<Response> {
  const endpoint = normalizeEndpoint(settings.endpoint)
  if (!endpoint) throw new ServerError('No server is set up yet.')
  try {
    return await fetchImpl(`${endpoint}${path}`, { ...init, headers: { ...authHeaders(settings), ...(init.headers as Record<string, string> | undefined) }, signal: init.signal ?? AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new ServerError(`Could not reach the server. ${errorMessage(error)}`)
  }
}

const refused = (response: Response) => response.status === 401 || response.status === 403
  ? new ServerError('This device is no longer connected. Connect it again in Settings.', response.status)
  : new ServerError(`The server answered ${response.status}.`, response.status)

/** Deletes a note from the server for good. A note the server no longer has counts as deleted. */
export async function deleteOnServer(settings: Credentials, id: string, fetchImpl: Fetch = fetch): Promise<void> {
  const response = await call(settings, `/v1/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl)
  if (response.status === 204 || response.status === 404) return
  throw refused(response)
}

/** Sends a rename or new tags. Resolves to "gone" when the server does not have the note. */
export async function editOnServer(settings: Credentials, id: string, edit: { title: string; tags: string[] }, fetchImpl: Fetch = fetch): Promise<'ok' | 'gone'> {
  const response = await call(settings, `/v1/notes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) }, fetchImpl)
  if (response.ok) return 'ok'
  if (response.status === 404) return 'gone'
  throw refused(response)
}

export interface PairStart { pairId: string; userCode: string; pollToken: string; verificationUrl: string; expiresIn: number; interval: number }
export type PairPoll = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; token: string; deviceId: string; endpoint: string }

/** The server is reachable but not set up for one-tap connecting. */
export class PairingUnavailable extends ServerError {}

export async function startPairing(endpoint: string, deviceName: string, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<PairStart> {
  const response = await call({ endpoint, token: '' }, '/v1/pair/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceName }), ...(signal ? { signal } : {}) }, fetchImpl)
  if (response.status === 501) throw new PairingUnavailable('This server is not set up for one-tap connecting.', 501)
  if (response.status === 429) throw new ServerError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Too many attempts. Try again in a few minutes.', 429)
  if (!response.ok) throw new ServerError(`The server answered ${response.status}.`, response.status)
  return (await response.json()) as PairStart
}

export async function pollPairing(endpoint: string, start: Pick<PairStart, 'pairId' | 'pollToken'>, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<PairPoll> {
  const response = await call({ endpoint, token: '' }, '/v1/pair/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairId: start.pairId, pollToken: start.pollToken }), ...(signal ? { signal } : {}) }, fetchImpl)
  if (!response.ok) throw new ServerError(`The server answered ${response.status}.`, response.status)
  return (await response.json()) as PairPoll
}

/** Cuts this device off on the server, so a lost phone cannot be used. Best effort: it is already forgotten locally. */
export async function disconnectThisDevice(settings: Credentials & Pick<Settings, 'deviceId'>, fetchImpl: Fetch = fetch): Promise<void> {
  if (!settings.deviceId || !settings.token) return
  try { await call(settings, `/v1/devices/${encodeURIComponent(settings.deviceId)}`, { method: 'DELETE' }, fetchImpl) } catch { /* the token is cleared locally either way */ }
}

export interface AccountInfo {
  /** Who this device belongs to. Null for a device connected the old way (with the server's own token). */
  account: { email: string; name: string } | null
  drive: { enabled: boolean; connected: boolean; canConnect: boolean }
}

/** Who this device is signed in as, and whether their Google Drive is connected. Null when the server cannot say. */
export async function fetchAccount(settings: Credentials, fetchImpl: Fetch = fetch): Promise<AccountInfo | null> {
  try {
    const [me, drive] = await Promise.all([call(settings, '/v1/me', {}, fetchImpl), call(settings, '/v1/drive', {}, fetchImpl)])
    if (!me.ok) return null
    const who = (await me.json()) as { account?: { email?: unknown; name?: unknown } | null }
    const state = drive.ok ? ((await drive.json()) as { enabled?: unknown; connected?: unknown; canConnect?: unknown }) : {}
    return {
      account: who.account && typeof who.account.email === 'string' ? { email: who.account.email, name: typeof who.account.name === 'string' ? who.account.name : who.account.email } : null,
      drive: { enabled: state.enabled === true, connected: state.connected === true, canConnect: state.canConnect === true },
    }
  } catch { return null }
}
