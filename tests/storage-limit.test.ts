import { describe, expect, it } from 'vitest'
import { KEEP_NEWEST, newNote, pickAudioForLimit, pickNewestAudio } from '../src/lib/notes'
import type { Note } from '../src/lib/types'

const MB = 1024 * 1024
/** Ten uploaded notes of 100 MB, `n1` the oldest. */
const notes = (count = 10, extra: (index: number) => Partial<Note> = () => ({})): Note[] =>
  Array.from({ length: count }, (_, index) => newNote({ id: `n${index + 1}`, createdAt: 1_000 + index, size: 100 * MB, status: 'uploaded', ...extra(index) }))
const ids = (list: Note[]) => list.map(note => note.id)

describe('freeing audio when the device passes its limit', () => {
  it('does nothing while under the limit, and nothing at all when the limit is 0', () => {
    expect(pickAudioForLimit(notes(2), 250)).toEqual([])
    expect(pickAudioForLimit(notes(10), 0)).toEqual([])
    expect(pickAudioForLimit(notes(10), -5)).toEqual([])
    expect(pickAudioForLimit(notes(10), Number.NaN)).toEqual([])
  })

  it('removes the oldest first, and stops as soon as the rest fits', () => {
    // 1000 MB on the device, limit 250: the 5 newest are protected (500 MB), so only the oldest notes can go.
    expect(pickAudioForLimit(notes(), 600)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(pickAudioForLimit(notes(), 800)).toEqual(['n1', 'n2'])
  })

  it('never touches the newest five notes, even when that leaves the device over its limit', () => {
    expect(pickAudioForLimit(notes(), 250)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
    expect(pickAudioForLimit(notes(6), 100)).toEqual(['n1'])
    expect(pickAudioForLimit(notes(KEEP_NEWEST), 1)).toEqual([])
  })

  it('never touches a note that has not reached the server, because its audio would be the only copy', () => {
    const list = notes(10, index => (index === 0 ? { status: 'local' } : index === 1 ? { status: 'failed' } : index === 2 ? { status: 'uploading' } : {}))
    expect(pickAudioForLimit(list, 250)).toEqual(['n4', 'n5'])
  })

  it('ignores audio that is already gone, and a recording still in progress', () => {
    const list = [...notes(10, index => (index < 3 ? { audioRemoved: true } : {})), newNote({ id: 'live', createdAt: 99_999, size: 900 * MB, status: 'recording' })]
    // 700 MB left on the device. The newest five saved notes (n6..n10) stay; n4 and n5 can go.
    expect(pickAudioForLimit(list, 600)).toEqual(['n4'])
    expect(pickAudioForLimit(list, 500)).toEqual(['n4', 'n5'])
  })

  it('protects the newest notes by when they were recorded, not by their position in the list', () => {
    const shuffled = [...notes()].reverse()
    expect(pickAudioForLimit(shuffled, 250)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])
  })
})

describe('also freeing the latest recordings', () => {
  it('picks the newest five that are on the server and still have audio', () => {
    expect(pickNewestAudio(notes())).toEqual(['n10', 'n9', 'n8', 'n7', 'n6'])
  })

  it('skips ones not yet uploaded or already freed, and never reaches back past the newest five', () => {
    const list = notes(10, index => (index === 9 ? { status: 'local' } : index === 8 ? { audioRemoved: true } : {}))
    expect(pickNewestAudio(list)).toEqual(['n8', 'n7', 'n6'])
  })

  it('does nothing when there is nothing to free', () => {
    expect(pickNewestAudio([])).toEqual([])
    expect(pickNewestAudio(notes(3, () => ({ status: 'local' })))).toEqual([])
  })
})
