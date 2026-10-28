import { addChunk, clearChunks, deleteNoteCompletely, putNote, readChunks, saveAudio, updateNote } from './db'
import { notifyChanged } from './changes'
import { micErrorMessage } from './errors'
import { pickMime } from './mime'
import { newNote } from './notes'
import { kickUploads } from './uploader'
import { ScreenLock } from './wakelock'
import type { Note, Settings } from './types'

export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'

export interface RecorderSnapshot {
  state: RecorderState
  noteId: string | null
  marks: number
  /** Something the person should know, such as the system muting the microphone. */
  warning: string | null
  /** Last problem that stopped a recording from starting. */
  error: string | null
}

export const LEVEL_BARS = 64

/** Records one note at a time. Audio is written to IndexedDB every second, so an interrupted note can be recovered. */
export class VoiceRecorder {
  private snapshot: RecorderSnapshot = { state: 'idle', noteId: null, marks: 0, warning: null, error: null }
  private readonly listeners = new Set<() => void>()
  private readonly screenLock = new ScreenLock()

  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private context: AudioContext | null = null
  private meterTimer: ReturnType<typeof setInterval> | undefined
  private releaseRecordingLock: (() => void) | null = null

  private note: Note | null = null
  private mime = ''
  private seq = 0
  private bytes = 0
  private writes: Promise<void> = Promise.resolve()
  private startedAt = 0
  private pausedTotal = 0
  private pausedAt = 0
  private marks: number[] = []
  private readonly levels = new Float32Array(LEVEL_BARS)
  private stopped: Promise<void> | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): RecorderSnapshot => this.snapshot

  /** Recorded time in ms, excluding pauses. */
  elapsedMs(): number {
    if (this.snapshot.state === 'idle' || this.snapshot.state === 'starting') return 0
    const end = this.snapshot.state === 'paused' ? this.pausedAt : performance.now()
    return Math.max(0, end - this.startedAt - this.pausedTotal)
  }

  /** The most recent input levels (0..1), oldest first. */
  getLevels(): Float32Array { return this.levels }

  private set(patch: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  async start(settings: Settings): Promise<void> {
    if (this.snapshot.state !== 'idle') return
    this.set({ state: 'starting', error: null, warning: null })
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This browser cannot record audio.')
      }
      this.stream = await this.openMicrophone(settings)
      this.mime = pickMime()
      const options: MediaRecorderOptions = { audioBitsPerSecond: settings.bitrate }
      if (this.mime) options.mimeType = this.mime
      this.recorder = new MediaRecorder(this.stream, options)
      this.mime = this.recorder.mimeType || this.mime || 'audio/webm'
    } catch (error) {
      this.cleanupDevices()
      this.set({ state: 'idle', error: micErrorMessage(error) })
      return
    }

    const note = newNote({ status: 'recording', mime: this.mime })
    this.note = note
    this.seq = 0
    this.bytes = 0
    this.marks = []
    this.pausedTotal = 0
    this.levels.fill(0)
    this.writes = putNote(note).then(() => notifyChanged())
    if (navigator.locks) {
      void navigator.locks.request(`tv-rec-${note.id}`, () => new Promise<void>(resolve => { this.releaseRecordingLock = resolve }))
    }

    const recorder = this.recorder
    recorder.ondataavailable = event => {
      if (!event.data.size) return
      const seq = this.seq++
      this.bytes += event.data.size
      const bytes = this.bytes
      const elapsed = Math.round(this.elapsedMs())
      this.writes = this.writes
        .then(() => addChunk(note.id, seq, event.data))
        .then(() => updateNote(note.id, { size: bytes, durationMs: elapsed }))
        .then(() => undefined)
        .catch(() => this.set({ warning: 'This device is running out of storage. Stop and save this note.' }))
    }
    this.stopped = new Promise(resolve => { recorder.onstop = () => resolve() })

    const track = this.stream?.getAudioTracks()[0]
    if (track) {
      track.onended = () => { if (this.snapshot.state === 'recording' || this.snapshot.state === 'paused') void this.stop() }
      track.onmute = () => this.set({ warning: 'The system muted the microphone. Keep this screen open while recording.' })
      track.onunmute = () => this.set({ warning: null })
    }

    this.startMeter()
    void this.screenLock.hold()
    this.startedAt = performance.now()
    recorder.start(1000)
    this.set({ state: 'recording', noteId: note.id, marks: 0 })
  }

  private async openMicrophone(settings: Settings): Promise<MediaStream> {
    const base: MediaTrackConstraints = {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      channelCount: 1,
    }
    if (settings.inputDeviceId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: settings.inputDeviceId } } })
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'OverconstrainedError') throw error
        // The chosen microphone is gone; fall back to the default one.
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base })
  }

  private startMeter() {
    if (!this.stream) return
    try {
      const context = new AudioContext()
      void context.resume().catch(() => undefined)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(this.stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      this.context = context
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      this.meterTimer = setInterval(() => {
        if (this.snapshot.state !== 'recording') return
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
        this.levels.copyWithin(0, 1)
        this.levels[LEVEL_BARS - 1] = level
      }, reduce ? 250 : 70)
    } catch {
      // The level meter is a nicety; recording does not depend on it.
    }
  }

  pause(): void {
    if (this.snapshot.state !== 'recording' || this.recorder?.state !== 'recording') return
    this.recorder.pause()
    this.pausedAt = performance.now()
    this.set({ state: 'paused' })
  }

  resume(): void {
    if (this.snapshot.state !== 'paused' || this.recorder?.state !== 'paused') return
    this.pausedTotal += performance.now() - this.pausedAt
    this.recorder.resume()
    this.set({ state: 'recording' })
  }

  /** Marks the current moment, for example "this part matters". */
  mark(): void {
    if (!this.note || (this.snapshot.state !== 'recording' && this.snapshot.state !== 'paused')) return
    this.marks.push(Math.round(this.elapsedMs()))
    const marks = [...this.marks]
    void updateNote(this.note.id, { marks })
    this.set({ marks: marks.length })
  }

  /** Stops, saves the note and hands it to the upload queue. Resolves with the saved note, or null when nothing was captured. */
  async stop(): Promise<Note | null> {
    const note = this.note
    const recorder = this.recorder
    if (!note || !recorder || this.snapshot.state === 'stopping' || this.snapshot.state === 'idle') return null
    const durationMs = Math.round(this.elapsedMs())
    this.set({ state: 'stopping' })
    if (recorder.state !== 'inactive') recorder.stop()
    await this.stopped
    await this.writes
    this.cleanupDevices()

    const chunks = await readChunks(note.id)
    const blob = new Blob(chunks, { type: this.mime.split(';')[0] || 'audio/webm' })
    let saved: Note | null = null
    if (blob.size > 0) {
      await saveAudio(note.id, blob)
      saved = (await updateNote(note.id, { status: 'local', size: blob.size, durationMs, marks: [...this.marks] })) ?? null
      await clearChunks(note.id)
    } else {
      await deleteNoteCompletely(note.id)
    }
    this.releaseRecordingLock?.()
    this.releaseRecordingLock = null
    this.note = null
    this.recorder = null
    this.set({ state: 'idle', noteId: null, marks: 0, warning: saved ? null : 'Nothing was recorded.' })
    notifyChanged()
    if (saved) kickUploads()
    return saved
  }

  private cleanupDevices() {
    clearInterval(this.meterTimer)
    this.meterTimer = undefined
    void this.context?.close().catch(() => undefined)
    this.context = null
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    this.stream = null
    void this.screenLock.release()
  }
}

export const recorder = new VoiceRecorder()
