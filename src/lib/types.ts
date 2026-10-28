export type NoteStatus = 'recording' | 'local' | 'uploading' | 'uploaded' | 'failed'

export interface Note {
  id: string
  /** Start of the recording, ms since epoch. */
  createdAt: number
  durationMs: number
  mime: string
  size: number
  title: string
  tags: string[]
  /** Moments marked while recording, ms from the start (pauses excluded). */
  marks: number[]
  status: NoteStatus
  attempts: number
  /** Earliest time the next automatic attempt may run. */
  nextAttemptAt: number | null
  lastError: string | null
  uploadedAt: number | null
  /** The recording was cut short (crash, closed tab) and rebuilt from saved chunks. */
  recovered: boolean
  source: 'record' | 'import'
  /** The audio file was removed from this device after a successful upload. */
  audioRemoved: boolean
}

export interface Settings {
  endpoint: string
  token: string
  deviceName: string
  autoUpload: boolean
  /** Days the audio stays on this device after upload. 0 removes it straight away, -1 keeps it. */
  keepAfterUpload: number
  /** Opus bits per second. */
  bitrate: number
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  inputDeviceId: string
  /** Start recording as soon as the app opens. */
  recordOnOpen: boolean
}

export function guessDeviceName(userAgent: string): string {
  if (/android/i.test(userAgent)) return 'Android phone'
  if (/iphone|ipad/i.test(userAgent)) return 'iPhone'
  if (/windows/i.test(userAgent)) return 'Windows computer'
  if (/mac os/i.test(userAgent)) return 'Mac'
  if (/linux/i.test(userAgent)) return 'Linux computer'
  return 'This device'
}

export const DEFAULT_SETTINGS: Settings = {
  endpoint: '',
  token: '',
  deviceName: typeof navigator === 'undefined' ? 'This device' : guessDeviceName(navigator.userAgent),
  autoUpload: true,
  keepAfterUpload: 7,
  bitrate: 32000,
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: true,
  inputDeviceId: '',
  recordOnOpen: false,
}

export const APP_VERSION = '0.1.0'
