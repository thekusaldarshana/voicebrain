import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Digest, NoteEdits, NoteMeta, NoteState, Transcript } from './types.ts'
import { NoteGone, UUID, readJson, writeFileAtomic, writeJson } from './util.ts'

/**
 * data/inbox/<id>/
 *   meta.json        what the app sent (immutable)
 *   audio.<ext>      the recording (immutable)
 *   transcript.json  the raw words: the permanent record
 *   digest.json      model extraction (regenerable)
 *   state.json       retry bookkeeping
 *   edits.json       later edits to the title and tags (by the user or the assistant)
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

  /** Ids of real notes. A folder without meta.json (a half-written or half-deleted note) does not count. */
  async ids(): Promise<string[]> {
    let names: string[]
    try { names = (await readdir(this.inbox)).filter(name => UUID.test(name)).sort() } catch { return [] }
    const present = await Promise.all(names.map(name => this.has(name)))
    return names.filter((_, index) => present[index])
  }

  meta(id: string) { return readJson<NoteMeta>(join(this.dir(id), 'meta.json')) }
  transcript(id: string) { return readJson<Transcript>(join(this.dir(id), 'transcript.json')) }
  digest(id: string) { return readJson<Digest>(join(this.dir(id), 'digest.json')) }
  async state(id: string): Promise<NoteState> {
    return (await readJson<NoteState>(join(this.dir(id), 'state.json'))) ?? { attempts: 0, nextAttemptAt: null, lastError: null, failed: false, stage: null }
  }

  edits(id: string) { return readJson<NoteEdits>(join(this.dir(id), 'edits.json')) }

  /** Every write checks the note still exists, so work that finishes after a delete cannot bring a note back. */
  private async write(id: string, file: string, value: unknown): Promise<void> {
    if (!(await this.has(id))) throw new NoteGone(id)
    await writeJson(join(this.dir(id), file), value)
  }
  writeTranscript(id: string, transcript: Transcript) { return this.write(id, 'transcript.json', transcript) }
  writeDigest(id: string, digest: Digest) { return this.write(id, 'digest.json', digest) }
  writeState(id: string, state: NoteState) { return this.write(id, 'state.json', state) }
  writeEdits(id: string, edits: NoteEdits) { return this.write(id, 'edits.json', edits) }

  /** Removes the audio, the transcript and everything else stored for the note. */
  async deleteNote(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true })
  }

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
