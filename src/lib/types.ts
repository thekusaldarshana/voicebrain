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
  /** A rename or tag change that has not reached the server yet. */
  editPending?: boolean
  /** The name the server shows for this note (the assistant's rename, or the model's title). Used when the person gave none. */
  remoteTitle?: string
  /** Opens this note's folder in the person's Google Drive. Only when the server keeps notes there. */
  driveUrl?: string
}

export interface Settings {
  endpoint: string
  /** This device's own token, handed over when the owner approved it (or one pasted in by hand). */
  token: string
  /** The server's id for this device, used to disconnect it. Empty for a pasted token. */
  deviceId: string
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
  deviceId: '',
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

export const APP_VERSION = '0.2.0'
