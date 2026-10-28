import { getKv, setKv } from './db'
import { normalizeEndpoint } from './endpoint'
import { DEFAULT_SETTINGS, type Settings } from './types'

const KEY = 'settings'

export async function loadSettings(): Promise<Settings> {
  const stored = await getKv<Partial<Settings>>(KEY).catch(() => undefined)
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
}

/** Merges a change into the stored settings. Reading first keeps edits from different tabs from overwriting each other. */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const merged = { ...(await loadSettings()), ...patch }
  const clean: Settings = { ...merged, endpoint: merged.endpoint ? normalizeEndpoint(merged.endpoint) || merged.endpoint.trim() : '', token: merged.token.trim() }
  await setKv(KEY, clean)
  return clean
}
