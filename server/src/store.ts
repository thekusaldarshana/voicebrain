import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Digest, NoteMeta, NoteState, Transcript } from './types.ts'
import { UUID, readJson, writeFileAtomic, writeJson } from './util.ts'

/**
 * data/inbox/<id>/
 *   meta.json        what the app sent (immutable)
 *   audio.<ext>      the recording (immutable)
 *   transcript.json  the raw words: the permanent record
 *   digest.json      model extraction (regenerable)
 *   state.json       retry bookkeeping
 */
export class Store {
  readonly dataDir: string
  readonly inbox: string
  readonly vault: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.inbox = join(dataDir, 'inbox')
    this.vault = join(dataDir, 'vault')
  }

  dir(id: string): string {
    if (!UUID.test(id)) throw new Error('bad note id')
    return join(this.inbox, id)
  }

  async has(id: string): Promise<boolean> {
    try { await stat(join(this.dir(id), 'meta.json')); return true } catch { return false }
  }

  async ids(): Promise<string[]> {
    try { return (await readdir(this.inbox)).filter(name => UUID.test(name)).sort() } catch { return [] }
  }

  meta(id: string) { return readJson<NoteMeta>(join(this.dir(id), 'meta.json')) }
  transcript(id: string) { return readJson<Transcript>(join(this.dir(id), 'transcript.json')) }
  digest(id: string) { return readJson<Digest>(join(this.dir(id), 'digest.json')) }
  async state(id: string): Promise<NoteState> {
    return (await readJson<NoteState>(join(this.dir(id), 'state.json'))) ?? { attempts: 0, nextAttemptAt: null, lastError: null, failed: false, stage: null }
  }

  writeTranscript(id: string, transcript: Transcript) { return writeJson(join(this.dir(id), 'transcript.json'), transcript) }
  writeDigest(id: string, digest: Digest) { return writeJson(join(this.dir(id), 'digest.json'), digest) }
  writeState(id: string, state: NoteState) { return writeJson(join(this.dir(id), 'state.json'), state) }

  audioPath(meta: NoteMeta): string | null {
    return meta.audioFile ? join(this.dir(meta.id), meta.audioFile) : null
  }

  /** Stores an upload. The note only exists once complete, so a crash never leaves half a note. Returns false for a repeat. */
  async saveUpload(meta: NoteMeta, audio: Uint8Array, extension: string): Promise<boolean> {
    if (await this.has(meta.id)) return false
    const final = this.dir(meta.id)
    const partial = `${final}.partial-${randomUUID().slice(0, 8)}`
    await mkdir(partial, { recursive: true })
    try {
      await writeFileAtomic(join(partial, `audio.${extension}`), audio)
      await writeJson(join(partial, 'meta.json'), { ...meta, audioFile: `audio.${extension}`, audioBytes: audio.byteLength })
      await rename(partial, final)
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      if (await this.has(meta.id)) return false
      throw error
    }
    return true
  }

  /** A note typed or dictated in chat. No audio, and the "transcript" is the text itself. */
  async saveTextNote(meta: NoteMeta, text: string): Promise<void> {
    await mkdir(this.dir(meta.id), { recursive: true })
    await writeJson(join(this.dir(meta.id), 'transcript.json'), { text, language: null, durationSec: null, model: 'text', segments: [], suspectedSilence: false, createdAt: meta.receivedAt } satisfies Transcript)
    await writeJson(join(this.dir(meta.id), 'meta.json'), meta)
  }
}
