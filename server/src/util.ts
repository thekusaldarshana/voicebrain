import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PermanentError extends Error {}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return null }
}

export const writeJson = (path: string, value: unknown) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)

export function slugify(text: string, max = 48): string {
  const slug = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '')
  return slug || 'untitled'
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The wall-clock time where the note was recorded (the app sends its UTC offset). */
export function localParts(iso: string, utcOffsetMinutes: number) {
  const shifted = new Date(new Date(iso).getTime() + utcOffsetMinutes * 60_000)
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][shifted.getUTCDay()] as string
  const sign = utcOffsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(utcOffsetMinutes)
  return { date, time, weekday, offset: `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` }
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  return `${hours ? `${pad(hours)}:` : ''}${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}h ${pad(minutes)}m` : minutes ? `${minutes}m ${pad(seconds)}s` : `${seconds}s`
}

/** Retry delay: 5 s doubling up to 15 min, with jitter. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  return Math.round(Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1)) * (0.8 + random() * 0.4))
}

/** A promise queue: tasks run one at a time, in order, and one failure does not stop the next. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
