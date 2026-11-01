import type { Brain } from './brain.ts'
import { digestNote } from './digest.ts'
import { transcribeBytes, type Fetch } from './stt.ts'
import type { Digest, NoteState } from './types.ts'
import { NoteGone, PermanentError, errorText, retryDelayMs } from './util.ts'

export interface PipelineOptions { fetch?: Fetch; retryDelay?: (attempts: number) => number; log?: (message: string) => void }

export interface PipelineStatus {
  notes: number
  waiting: number
  failed: Array<{ id: string; stage: string | null; error: string | null }>
  needs: string[]
}

/** Moves each note through transcribe → digest → file. Every stage is saved to disk, so a restart picks up where it stopped. */
export class Pipeline {
  private readonly brain: Brain
  private readonly fetch: Fetch
  private readonly retryDelay: (attempts: number) => number
  private readonly log: (message: string) => void
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | null = null
  private again = false
  private stopped = false

  constructor(brain: Brain, options: PipelineOptions = {}) {
    this.brain = brain
    this.fetch = options.fetch ?? fetch
    this.retryDelay = options.retryDelay ?? (attempts => retryDelayMs(attempts))
    this.log = options.log ?? (message => console.log(message))
  }

  start(): void {
    this.stopped = false
    this.timer = setInterval(() => this.kick(), this.brain.config.workerIntervalMs)
    this.kick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    while (this.running) await this.running
  }

  /** Ask for a pass now. Passes never overlap; a request during a pass triggers one more afterwards. */
  kick(): void {
    if (this.stopped) return
    if (this.running) { this.again = true; return }
    this.running = this.pass().catch(error => this.log(`pipeline pass failed: ${errorText(error)}`)).finally(() => {
      this.running = null
      if (this.again) { this.again = false; this.kick() }
    })
  }

  /** Resolves when the current work, and anything requested while it ran, is done. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  async retry(id: string): Promise<boolean> {
    if (!(await this.brain.store.has(id))) return false
    await this.brain.store.writeState(id, { attempts: 0, nextAttemptAt: null, lastError: null, failed: false, stage: null })
    this.kick()
    return true
  }

  async status(): Promise<PipelineStatus> {
    const { store, config, index } = this.brain
    const ids = await store.ids()
    const failed: PipelineStatus['failed'] = []
    let waiting = 0
    for (const id of ids) {
      const state = await store.state(id)
      if (state.failed) failed.push({ id, stage: state.stage, error: state.lastError })
      else if (!(await store.digest(id)) || !index.note(id)) waiting += 1
    }
    const needs: string[] = []
    if (!config.stt) needs.push('STT_BASE_URL (voice notes cannot be transcribed yet)')
    if (!config.llm) needs.push('LLM_BASE_URL and LLM_MODEL (notes are saved but tasks are not extracted yet)')
    return { notes: ids.length, waiting, failed, needs }
  }

  private async pass(): Promise<void> {
    for (const id of await this.brain.store.ids()) await this.process(id)
  }

  private async process(id: string): Promise<void> {
    const { store, config, index } = this.brain
    const state = await store.state(id)
    if (state.failed || (state.nextAttemptAt !== null && state.nextAttemptAt > Date.now())) return
    const meta = await store.meta(id)
    if (!meta) return
    let stage: NoteState['stage'] = null
    try {
      let transcript = await store.transcript(id)
      if (!transcript) {
        if (!config.stt) return
        stage = 'transcribe'
        const audio = await store.audioBytes(meta)
        if (!audio) throw new PermanentError('This note has no audio and no text to work from.')
        transcript = await transcribeBytes(config.stt, audio, meta.audioFile ?? 'audio.webm', meta.mime, this.fetch)
        await store.writeTranscript(id, transcript)
        await this.brain.fileNote(id) // searchable straight away, even if the language model is down
        this.log(`transcribed ${id.slice(0, 8)} (${transcript.text.length} characters)`)
      }
      let digest = await store.digest(id)
      if (!digest) {
        if (!config.llm) return
        stage = 'digest'
        digest = transcript.suspectedSilence ? silentDigest(meta.title) : await digestNote(config.llm, meta, transcript, index.knownEntities(), this.fetch)
        await store.writeDigest(id, digest)
        this.log(`digested ${id.slice(0, 8)}: ${digest.tasks.length} task(s)`)
      }
      stage = 'file'
      const row = index.note(id)
      if (!row || (digest && !row.digested)) await this.brain.fileNote(id)
      if (state.attempts || state.lastError) await store.writeState(id, { attempts: 0, nextAttemptAt: null, lastError: null, failed: false, stage: null })
    } catch (error) {
      if (error instanceof NoteGone || !(await store.has(id))) return // deleted while we were working on it
      const attempts = state.attempts + 1
      const permanent = error instanceof PermanentError || attempts >= config.maxAttempts
      this.log(`${stage ?? 'process'} failed for ${id.slice(0, 8)} (attempt ${attempts}${permanent ? ', giving up' : ''}): ${errorText(error)}`)
      await store.writeState(id, { attempts, nextAttemptAt: permanent ? null : Date.now() + this.retryDelay(attempts), lastError: errorText(error).slice(0, 500), failed: permanent, stage })
    }
  }
}

function silentDigest(title: string): Digest {
  return { title: title || 'No speech detected', summary: '', tasks: [], ideas: [], decisions: [], questions: [], people: [], projects: [], tags: [], droppedItems: 0, model: 'none', createdAt: new Date().toISOString() }
}
