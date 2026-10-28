import { Check, CircleAlert, CloudOff, CloudUpload, HardDrive, LoaderCircle, Mic, type LucideIcon } from 'lucide-react'
import { formatUntil } from './format'
import { isConfigured } from './endpoint'
import type { Note, Settings } from './types'

export interface StatusView { icon: LucideIcon; text: string; detail?: string; tone: 'neutral' | 'good' | 'attention'; spinning?: boolean }

/** Words first: state is never carried by color or icon alone. */
export function describeStatus(note: Note, settings: Settings, now: number, online: boolean): StatusView {
  switch (note.status) {
    case 'recording': return { icon: Mic, text: 'Recording in progress', tone: 'neutral' }
    case 'uploading': return { icon: LoaderCircle, text: 'Uploading', tone: 'neutral', spinning: true }
    case 'uploaded': return { icon: Check, text: note.audioRemoved ? 'Uploaded · audio removed from this device' : 'Uploaded', tone: 'good' }
    case 'failed': return { icon: CircleAlert, text: 'Needs attention', detail: note.lastError ?? undefined, tone: 'attention' }
    default:
      if (!isConfigured(settings)) return { icon: HardDrive, text: 'Saved on this device', detail: 'Connect a server in Settings to upload.', tone: 'neutral' }
      if (!settings.autoUpload) return { icon: HardDrive, text: 'Saved on this device', detail: 'Automatic upload is off.', tone: 'neutral' }
      if (note.nextAttemptAt && note.nextAttemptAt > now) return { icon: CloudOff, text: `Will retry in ${formatUntil(note.nextAttemptAt - now)}`, detail: note.lastError ?? undefined, tone: 'neutral' }
      if (!online) return { icon: CloudOff, text: 'Waiting for a connection', tone: 'neutral' }
      return { icon: CloudUpload, text: 'Waiting to upload', tone: 'neutral' }
  }
}
