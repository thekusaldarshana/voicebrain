import { describe, expect, it } from 'vitest'
import { namePatch } from '../src/lib/names'
import { newNote } from '../src/lib/notes'

const server = (extra: Partial<Parameters<typeof namePatch>[1]> = {}) => ({ id: 'x', title: 'Rutherford and the gold foil', userTitle: '', drive: null, ...extra })

describe('naming a note from what the server says', () => {
  it('keeps the assistant’s name beside an empty title, so it shows without being the person’s own', () => {
    expect(namePatch(newNote(), server())).toEqual({ remoteTitle: 'Rutherford and the gold foil' })
  })

  it('does nothing when nothing changed', () => {
    const note = newNote({ remoteTitle: 'Rutherford and the gold foil', driveUrl: 'https://drive.google.com/drive/folders/x' })
    expect(namePatch(note, server({ drive: 'https://drive.google.com/drive/folders/x' }))).toEqual({})
  })

  it('never overwrites a name typed here that has not been sent yet', () => {
    const note = newNote({ title: 'Typed just now', editPending: true })
    expect(namePatch(note, server({ userTitle: 'Older name from the server' }))).toEqual({ remoteTitle: 'Rutherford and the gold foil' })
  })

  it('takes a name the person typed on another device', () => {
    expect(namePatch(newNote({ title: 'Old' }), server({ title: 'New', userTitle: 'New' }))).toEqual({ remoteTitle: 'New', title: 'New' })
  })

  it('does not turn the assistant’s name into the person’s own', () => {
    expect(namePatch(newNote({ title: '' }), server({ userTitle: '' }))).not.toHaveProperty('title')
  })

  it('adds or changes a Drive link, but a missing link never removes the one we have', () => {
    const linked = newNote({ driveUrl: 'https://drive.google.com/drive/folders/old', remoteTitle: 'Rutherford and the gold foil' })
    expect(namePatch(linked, server({ drive: 'https://drive.google.com/drive/folders/new' }))).toEqual({ driveUrl: 'https://drive.google.com/drive/folders/new' })
    expect(namePatch(linked, server({ drive: null }))).toEqual({})
  })
})
