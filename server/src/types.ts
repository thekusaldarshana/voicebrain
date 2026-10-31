/** What the app sent with the audio. Written once at ingest and never edited. */
export interface NoteMeta {
  id: string
  createdAt: string
  durationMs: number
  mime: string
  size: number
  title: string
  tags: string[]
  marks: number[]
  recovered: boolean
  source: 'record' | 'import' | 'text'
  device: string
  timezone: string
  utcOffsetMinutes: number
  app: string
  receivedAt: string
  audioFile: string | null
  audioBytes: number
}

export interface Segment { start: number; end: number; text: string }

/** The raw words. This is the permanent record; everything else can be regenerated from it. */
export interface Transcript {
  text: string
  language: string | null
  durationSec: number | null
  model: string
  segments: Segment[]
  /** The recognizer returned only filler it often invents for silence. Kept, but flagged. */
  suspectedSilence: boolean
  createdAt: string
}

export type Priority = 'high' | 'normal' | 'low'

export interface Task { text: string; due: string | null; project: string | null; priority: Priority; quote: string }
export interface Quoted { text: string; quote: string }
export interface Mention { name: string; context: string }

export interface Digest {
  title: string
  summary: string
  tasks: Task[]
  ideas: Quoted[]
  decisions: Quoted[]
  questions: Quoted[]
  people: Mention[]
  projects: Mention[]
  tags: string[]
  /** Items the model produced that could not be tied to words actually spoken, so they were left out. */
  droppedItems: number
  model: string
  createdAt: string
}

/** Operational state only (retries). Never the source of truth for content. */
export interface NoteState {
  attempts: number
  nextAttemptAt: number | null
  lastError: string | null
  failed: boolean
  stage: 'transcribe' | 'digest' | 'file' | null
}

export type TaskStatus = 'open' | 'done' | 'dismissed'
export interface TaskStatusEntry { status: TaskStatus; updatedAt: string }
