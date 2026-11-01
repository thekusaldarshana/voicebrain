import { afterEach, describe, expect, it } from 'vitest'
import { OWNER_ID, readAll, type NoteStorage, type RetainAudio } from '../src/storage.ts'
import { NoteGone } from '../src/util.ts'

export interface ContractTarget {
  storage: NoteStorage
  cleanup: () => Promise<void>
}

export interface ContractOptions {
  /** Builds a fresh, empty backend. */
  make: (options: { retainAudio?: RetainAudio }) => Promise<ContractTarget>
  /** Whether the backend can honor `retainAudio: 'drop-after-digest'` (it has a durable copy besides its local one). */
  dropsAudio: boolean
}

const A = '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b'
const B = '44444444-4444-4444-8444-444444444444'
const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes))
const meta = (id: string) => encode(JSON.stringify({ id }))
const binary = () => Uint8Array.from({ length: 4096 }, (_, index) => index % 256)
const chunked = (chunks: Uint8Array[], options: { failAfter?: number; gate?: Promise<void> } = {}): ReadableStream<Uint8Array> => {
  let sent = 0
  return new ReadableStream({
    async pull(controller) {
      if (options.gate && sent === 1) await options.gate
      if (options.failAfter !== undefined && sent >= options.failAfter) { controller.error(new Error('the connection dropped')); return }
      const next = chunks[sent]
      if (next) { controller.enqueue(next); sent += 1 } else controller.close()
    },
  })
}

/**
 * The behavior every NoteStorage backend must have. Run it against each backend:
 *
 *   storageContract('local', { make: ..., dropsAudio: false })
 *
 * A Google Drive backend joins by adding one more call (pointed at a fake Drive, or a scratch folder).
 */
export function storageContract(name: string, options: ContractOptions): void {
  describe(`NoteStorage contract: ${name}`, () => {
    const cleanups: Array<() => Promise<void>> = []
    afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
    const fresh = async (retainAudio?: RetainAudio) => {
      const target = await options.make({ retainAudio })
      cleanups.push(target.cleanup)
      return target.storage
    }

    describe('notes', () => {
      it('starts empty, then lists notes sorted once they are created', async () => {
        const storage = await fresh()
        expect(await storage.listNotes(OWNER_ID)).toEqual([])
        expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
        expect(await storage.createNote(OWNER_ID, B, { meta: meta(B) })).toBe(true)
        expect(await storage.createNote(OWNER_ID, A, { meta: meta(A) })).toBe(true)
        expect(await storage.listNotes(OWNER_ID)).toEqual([A, B].sort())
        expect(await storage.hasNote(OWNER_ID, A)).toBe(true)
        expect(decode(await storage.get(OWNER_ID, A, 'meta.json'))).toBe(JSON.stringify({ id: A }))
      })

      it('answers false for a repeat and leaves the first copy untouched', async () => {
        const storage = await fresh()
        expect(await storage.createNote(OWNER_ID, A, { meta: encode('first'), files: { 'audio.webm': binary() } })).toBe(true)
        expect(await storage.createNote(OWNER_ID, A, { meta: encode('second'), files: { 'audio.webm': encode('other') } })).toBe(false)
        expect(decode(await storage.get(OWNER_ID, A, 'meta.json'))).toBe('first')
        expect(await storage.get(OWNER_ID, A, 'audio.webm')).toEqual(binary())
      })

      it('creates a note atomically: a stream that fails midway leaves no note and no trace', async () => {
        const storage = await fresh()
        const broken = chunked([encode('one'), encode('two'), encode('three')], { failAfter: 1 })
        await expect(storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': broken } })).rejects.toThrow()
        expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
        expect(await storage.listNotes(OWNER_ID)).toEqual([])
        expect(await storage.list(OWNER_ID, A)).toEqual([])
        // and the id is not poisoned: a retry succeeds
        expect(await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': chunked([encode('one'), encode('two')]) } })).toBe(true)
        expect(decode(await storage.get(OWNER_ID, A, 'audio.webm'))).toBe('onetwo')
      })

      it('refuses meta.json inside files', async () => {
        const storage = await fresh()
        await expect(storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'meta.json': encode('x') } })).rejects.toThrow()
        expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
      })

      it('creates a text note with its transcript from the first moment', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'transcript.json': encode('{"text":"hi"}') } })
        expect(await storage.list(OWNER_ID, A)).toEqual(['meta.json', 'transcript.json'])
      })
    })

    describe('concurrency', () => {
      it('lets exactly one of many simultaneous creates of the same note win, and leaves one intact note', async () => {
        const storage = await fresh()
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => storage.createNote(OWNER_ID, A, { meta: encode(`meta ${index}`), files: { 'audio.webm': encode(`audio ${index}`) } })))
        expect(results.filter(Boolean)).toHaveLength(1)
        const winner = results.indexOf(true)
        expect(decode(await storage.get(OWNER_ID, A, 'meta.json'))).toBe(`meta ${winner}`)
        expect(decode(await storage.get(OWNER_ID, A, 'audio.webm'))).toBe(`audio ${winner}`) // the winner's files, not a mix
        expect(await storage.list(OWNER_ID, A)).toEqual(['audio.webm', 'meta.json'])
        expect(await storage.listNotes(OWNER_ID)).toEqual([A])
      })

      it('creates many different notes at once without losing or duplicating any', async () => {
        const storage = await fresh()
        const ids = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
        expect(await Promise.all(ids.map(id => storage.createNote(OWNER_ID, id, { meta: meta(id), files: { 'audio.webm': encode(id) } })))).toEqual(ids.map(() => true))
        expect(await storage.listNotes(OWNER_ID)).toEqual(ids)
        for (const id of ids) expect(decode(await storage.get(OWNER_ID, id, 'audio.webm'))).toBe(id)
      })

      it('serializes simultaneous writes to one file: the last one wins whole', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A) })
        await Promise.all(Array.from({ length: 6 }, (_, index) => storage.put(OWNER_ID, A, 'digest.json', encode(`version ${index}`))))
        expect(decode(await storage.get(OWNER_ID, A, 'digest.json'))).toMatch(/^version \d$/)
        expect(await storage.list(OWNER_ID, A)).toEqual(['digest.json', 'meta.json']) // one digest.json, not six
      })
    })

    describe('files', () => {
      it('round-trips binary data exactly, and says null for what is not there', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A) })
        await storage.put(OWNER_ID, A, 'audio.webm', binary())
        expect(await storage.get(OWNER_ID, A, 'audio.webm')).toEqual(binary())
        expect(await storage.get(OWNER_ID, A, 'digest.json')).toBeNull()
        expect(await storage.get(OWNER_ID, B, 'meta.json')).toBeNull()
      })

      it('replaces a file, and lists only real filenames', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': binary() } })
        await storage.put(OWNER_ID, A, 'transcript.json', encode('v1'))
        await storage.put(OWNER_ID, A, 'transcript.json', encode('v2'))
        await storage.put(OWNER_ID, A, 'state.json', encode('{}'))
        expect(decode(await storage.get(OWNER_ID, A, 'transcript.json'))).toBe('v2')
        expect(await storage.list(OWNER_ID, A)).toEqual(['audio.webm', 'meta.json', 'state.json', 'transcript.json'])
        expect(await storage.list(OWNER_ID, B)).toEqual([])
      })

      it('writes streams too', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A) })
        await storage.put(OWNER_ID, A, 'audio.webm', chunked([binary().slice(0, 1000), binary().slice(1000)]))
        expect(await storage.get(OWNER_ID, A, 'audio.webm')).toEqual(binary())
      })

      it('never shows a reader a half-written or mixed file', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A) })
        const size = 200_000
        const fill = (byte: number) => new Uint8Array(size).fill(byte)
        await storage.put(OWNER_ID, A, 'edits.json', fill(0))
        const writes = Array.from({ length: 12 }, (_, index) => storage.put(OWNER_ID, A, 'edits.json', fill(index + 1)))
        const reads = Array.from({ length: 24 }, async () => {
          const seen = await storage.get(OWNER_ID, A, 'edits.json')
          if (seen === null) return 'missing'
          return seen.byteLength === size && seen.every(byte => byte === seen[0]) ? 'whole' : 'torn'
        })
        const results = await Promise.all([...writes, ...reads])
        expect(results.filter(result => result === 'missing' || result === 'torn')).toEqual([])
      })

      it('throws NoteGone for a note that does not exist, and leaves nothing behind', async () => {
        const storage = await fresh()
        await expect(storage.put(OWNER_ID, A, 'transcript.json', encode('x'))).rejects.toBeInstanceOf(NoteGone)
        expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
        expect(await storage.list(OWNER_ID, A)).toEqual([])
        expect(await storage.listNotes(OWNER_ID)).toEqual([])
      })
    })

    describe('deleting', () => {
      it('removes every file, is idempotent, and leaves other notes alone', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': binary(), 'transcript.json': encode('t') } })
        await storage.put(OWNER_ID, A, 'digest.json', encode('d'))
        await storage.put(OWNER_ID, A, 'edits.json', encode('e'))
        await storage.put(OWNER_ID, A, 'state.json', encode('s'))
        await storage.createNote(OWNER_ID, B, { meta: meta(B), files: { 'audio.webm': encode('keep me') } })
        await storage.deleteNote(OWNER_ID, A)
        await storage.deleteNote(OWNER_ID, A)
        await storage.deleteNote(OWNER_ID, '55555555-5555-4555-8555-555555555555')
        expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
        expect(await storage.list(OWNER_ID, A)).toEqual([])
        for (const file of ['meta.json', 'audio.webm', 'transcript.json', 'digest.json', 'edits.json', 'state.json']) expect(await storage.get(OWNER_ID, A, file), file).toBeNull()
        expect(await storage.getStream(OWNER_ID, A, 'audio.webm')).toBeNull()
        expect(await storage.listNotes(OWNER_ID)).toEqual([B])
        expect(decode(await storage.get(OWNER_ID, B, 'audio.webm'))).toBe('keep me')
      })

      it('lets the same id be created again afterwards', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: encode('old') })
        await storage.deleteNote(OWNER_ID, A)
        expect(await storage.createNote(OWNER_ID, A, { meta: encode('new') })).toBe(true)
        expect(decode(await storage.get(OWNER_ID, A, 'meta.json'))).toBe('new')
      })

      it('wins against a write that is still arriving: the write fails with NoteGone and nothing comes back', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A) })
        let open!: () => void
        const gate = new Promise<void>(done => { open = done })
        const slow = storage.put(OWNER_ID, A, 'transcript.json', chunked([encode('first half'), encode(' second half')], { gate }))
        const outcome = slow.then(() => 'written', error => error)
        await new Promise(done => setTimeout(done, 20)) // the write is under way, held at the gate
        await storage.deleteNote(OWNER_ID, A)
        open()
        expect(await outcome).toBeInstanceOf(NoteGone)
        expect(await storage.hasNote(OWNER_ID, A)).toBe(false)
        expect(await storage.list(OWNER_ID, A)).toEqual([])
        expect(await storage.listNotes(OWNER_ID)).toEqual([])
        expect(await storage.get(OWNER_ID, A, 'transcript.json')).toBeNull()
      })
    })

    describe('users', () => {
      it('keeps each user\'s notes apart, even for the same note id', async () => {
        const storage = await fresh()
        await storage.createNote('alice', A, { meta: encode('alice'), files: { 'audio.webm': encode('a-audio') } })
        await storage.createNote('bob', A, { meta: encode('bob') })
        expect(decode(await storage.get('alice', A, 'meta.json'))).toBe('alice')
        expect(decode(await storage.get('bob', A, 'meta.json'))).toBe('bob')
        expect(await storage.listNotes('alice')).toEqual([A])
        expect(await storage.listNotes(OWNER_ID)).toEqual([])
        await storage.deleteNote('bob', A)
        expect(await storage.hasNote('alice', A)).toBe(true)
        expect(decode(await storage.get('alice', A, 'audio.webm'))).toBe('a-audio')
        await expect(storage.put('bob', A, 'edits.json', encode('x'))).rejects.toBeInstanceOf(NoteGone)
      })

      it('does not let the owner and another user see each other', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A) })
        expect(await storage.hasNote('alice', A)).toBe(false)
        expect(await storage.listNotes('alice')).toEqual([])
      })
    })

    describe('names are checked', () => {
      it('rejects ids and filenames that could escape or confuse a path', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A) })
        for (const user of ['', '../x', 'a/b', '.hidden', 'x'.repeat(65)]) {
          await expect(storage.listNotes(user), `user ${user}`).rejects.toThrow()
          await expect(storage.createNote(user, A, { meta: meta(A) }), `user ${user}`).rejects.toThrow()
        }
        for (const note of ['', 'nope', '../../etc', `${A}/..`, A.toUpperCase().slice(0, 35)]) {
          await expect(storage.hasNote(OWNER_ID, note), `note ${note}`).rejects.toThrow()
          await expect(storage.deleteNote(OWNER_ID, note), `note ${note}`).rejects.toThrow()
        }
        for (const file of ['', '../meta.json', 'a/b.json', '/etc/passwd', '.hidden', 'a..b', 'x.tmp', 'a b.json', 'x'.repeat(101)]) {
          await expect(storage.get(OWNER_ID, A, file), `file ${file}`).rejects.toThrow()
          await expect(storage.put(OWNER_ID, A, file, encode('x')), `file ${file}`).rejects.toThrow()
          await expect(storage.getStream(OWNER_ID, A, file), `file ${file}`).rejects.toThrow()
        }
        expect(await storage.list(OWNER_ID, A)).toEqual(['meta.json'])
      })
    })

    describe('audio', () => {
      it('streams audio back in full, with its size', async () => {
        const storage = await fresh()
        await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': chunked([binary().slice(0, 100), binary().slice(100, 3000), binary().slice(3000)]) } })
        const found = await storage.getStream(OWNER_ID, A, 'audio.webm')
        expect(found).not.toBeNull()
        if (found?.size != null) expect(found.size).toBe(binary().byteLength)
        expect(await readAll(found!.stream)).toEqual(binary())
        expect(await storage.getStream(OWNER_ID, A, 'audio.mp3')).toBeNull()
        expect(await storage.getStream(OWNER_ID, B, 'audio.webm')).toBeNull()
      })

      it('keeps audio under the default policy, and releasing a note that is gone is harmless', async () => {
        const storage = await fresh()
        expect(storage.retainAudio).toBe('keep')
        await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': binary() } })
        await storage.releaseAudio(OWNER_ID, A)
        expect(await storage.get(OWNER_ID, A, 'audio.webm')).toEqual(binary())
        await storage.releaseAudio(OWNER_ID, B)
        await expect(storage.releaseAudio(OWNER_ID, 'nope')).rejects.toThrow()
      })

      if (options.dropsAudio) {
        it('drop-after-digest: the local copy goes, the audio does not; it is fetched back on demand', async () => {
          const storage = await fresh('drop-after-digest')
          expect(storage.retainAudio).toBe('drop-after-digest')
          await storage.createNote(OWNER_ID, A, { meta: meta(A), files: { 'audio.webm': binary(), 'transcript.json': encode('t') } })
          await storage.releaseAudio(OWNER_ID, A)
          expect(await storage.list(OWNER_ID, A)).toEqual(['audio.webm', 'meta.json', 'transcript.json']) // still the note's audio
          expect(await readAll((await storage.getStream(OWNER_ID, A, 'audio.webm'))!.stream)).toEqual(binary())
          expect(await storage.get(OWNER_ID, A, 'audio.webm')).toEqual(binary())
          expect(decode(await storage.get(OWNER_ID, A, 'transcript.json'))).toBe('t') // only audio is ever released
        })
      } else {
        it('refuses drop-after-digest instead of destroying the only copy', async () => {
          await expect(options.make({ retainAudio: 'drop-after-digest' })).rejects.toThrow(/only copy/)
        })
      }
    })
  })
}
