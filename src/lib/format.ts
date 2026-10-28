const pad = (value: number) => String(value).padStart(2, '0')

/** `00:00:00`, the live session format used across Trapper. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** `2m 14s`, `45s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}h ${pad(minutes)}m`
  if (minutes) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function dayKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dayHeading(key: string, todayKey: string): string {
  if (key === todayKey) return 'Today'
  const date = new Date(`${key}T12:00:00`)
  const yesterday = new Date(`${todayKey}T12:00:00`)
  yesterday.setDate(yesterday.getDate() - 1)
  if (key === dayKey(yesterday.getTime())) return 'Yesterday'
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'long' }).format(date)
}

export function clockTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function defaultTitle(createdAt: number): string {
  return `Voice note · ${clockTime(createdAt)}`
}

/** `in 40s`, `in 3m`. */
export function formatUntil(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

export function parseTags(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[,\n]/)) {
    const tag = part.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')
    if (tag) seen.add(tag.slice(0, 40))
  }
  return [...seen].slice(0, 12)
}
