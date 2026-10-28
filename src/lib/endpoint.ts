import type { Settings } from './types'

const LOCAL_HOST = /^(?:https?:\/\/)?(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^/:@]+\.local)(?::\d+)?(?:[/?#]|$)/i

/** True for addresses on your own network, where plain http is acceptable. */
export function isPrivateAddress(input: string): boolean {
  return LOCAL_HOST.test(input.trim())
}

/** Accepts `notes.example.com`, adds a scheme, drops trailing slashes. Empty when it is not a usable address. */
export function normalizeEndpoint(input: string): string {
  const text = input.trim()
  if (!text) return ''
  const withScheme = /^https?:\/\//i.test(text) ? text : `${LOCAL_HOST.test(text) ? 'http' : 'https'}://${text}`
  try {
    const url = new URL(withScheme)
    if (!url.hostname) return ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

export function isConfigured(settings: Pick<Settings, 'endpoint'>): boolean {
  return normalizeEndpoint(settings.endpoint) !== ''
}

/** `#/pair?e=<endpoint>&t=<token>&n=<device name>`. The fragment never reaches a server. */
export function parsePairing(hash: string): { endpoint: string; token: string; deviceName: string } | null {
  const match = /^#\/?pair\?(.*)$/.exec(hash)
  if (!match) return null
  const params = new URLSearchParams(match[1])
  const endpoint = normalizeEndpoint(params.get('e') ?? '')
  if (!endpoint) return null
  return { endpoint, token: params.get('t') ?? '', deviceName: params.get('n') ?? '' }
}
