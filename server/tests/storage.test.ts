import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalStorage } from '../src/storage-local.ts'
import { OWNER_ID } from '../src/storage.ts'
import { NoteGone } from '../src/util.ts'
import { MemoryStorage } from './memory-storage.ts'
import { storageContract } from './storage-contract.ts'
import { tempDir } from './helpers.ts'

storageContract('LocalStorage', {
  dropsAudio: false,
  make: async options => {
    const dir = await tempDir()
    try { return { storage: new LocalStorage(dir.dir, options), cleanup: dir.clean } } catch (error) { await dir.clean(); throw error }
  },
})

storageContract('MemoryStorage (the test fake)', {
  dropsAudio: true,
  make: async options => ({ storage: new MemoryStorage(options), cleanup: async () => undefined }),
})

const A = '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b'
const enc = (text: string) => new TextEncoder().encode(text)

describe('LocalStorage on disk', () => {
  it('keeps the layout the server has always had', async () => {
    const dir = await tempDir()
    try {
      const storage = new LocalStorage(dir.dir)
      await storage.createNote(OWNER_ID, A, { meta: enc('{"id":1}\n'), files: { 'audio.webm': enc('sound') } })
      await storage.put(OWNER_ID, A, 'transcript.json', enc('{}'))
      expect((await readdir(join(dir.dir, 'inbox', A))).sort()).toEqual(['audio.webm', 'meta.json', 'transcript.json'])
      expect(await readFile(join(dir.dir, 'inbox', A, 'audio.webm'), 'utf8')).toBe('sound')
      expect(await readdir(join(dir.dir, 'inbox'))).toEqual([A]) // no temporary or partial folders left
    } finally { await dir.clean() }
  })

  it('gives other users their own folder, and the owner the old one', async () => {
    const dir = await tempDir()
    try {
      const storage = new LocalStorage(dir.dir)
      await storage.createNote('alice', A, { meta: enc('{}') })
      expect(existsSync(join(dir.dir, 'users', 'alice', 'inbox', A, 'meta.json'))).toBe(true)
      expect(existsSync(join(dir.dir, 'inbox'))).toBe(false)
    } finally { await dir.clean() }
  })

  it('leaves no folder behind after a delete, or after a write that lost the race with it', async () => {
    const dir = await tempDir()
    try {
      const storage = new LocalStorage(dir.dir)
      await storage.createNote(OWNER_ID, A, { meta: enc('{}'), files: { 'audio.webm': enc('sound') } })
      await storage.deleteNote(OWNER_ID, A)
      await expect(storage.put(OWNER_ID, A, 'transcript.json', enc('late'))).rejects.toBeInstanceOf(NoteGone)
      expect(await readdir(join(dir.dir, 'inbox'))).toEqual([])
    } finally { await dir.clean() }
  })

  it('ignores a half-written folder, and finishes a delete that was interrupted', async () => {
    const dir = await tempDir()
    try {
      const storage = new LocalStorage(dir.dir)
      await mkdir(join(dir.dir, 'inbox', A), { recursive: true }) // no meta.json: not a note
      await writeFile(join(dir.dir, 'inbox', A, 'audio.webm'), 'x')
      await mkdir(join(dir.dir, 'inbox', `${A}.deleting-abcd1234`))
      await writeFile(join(dir.dir, 'inbox', `${A}.deleting-abcd1234`, 'transcript.json'), 'private words')
      expect(await storage.listNotes(OWNER_ID)).toEqual([])
      expect(existsSync(join(dir.dir, 'inbox', `${A}.deleting-abcd1234`))).toBe(false) // swept: no trace
      await expect(storage.put(OWNER_ID, A, 'transcript.json', enc('x'))).rejects.toBeInstanceOf(NoteGone)
    } finally { await dir.clean() }
  })
})
