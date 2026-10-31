import { describe, expect, it } from 'vitest'
import { Index } from '../src/index.ts'
import type { NoteMeta, Transcript } from '../src/types.ts'
import { cleanDigest } from '../src/digest.ts'
import { DIGEST, TRANSCRIPT } from './helpers.ts'

const meta = (id: string, createdAt: string, title = ''): NoteMeta => ({ id, createdAt, durationMs: 1000, mime: 'audio/webm', size: 1, title, tags: [], marks: [], recovered: false, source: 'record', device: 'd', timezone: 'Asia/Colombo', utcOffsetMinutes: 330, app: 'x', receivedAt: '', audioFile: null, audioBytes: 0 })
const transcript = (text: string): Transcript => ({ text, language: 'en', durationSec: 1, model: 'm', segments: [], suspectedSilence: false, createdAt: '' })
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const digestA = { ...cleanDigest(DIGEST, TRANSCRIPT), model: 'm', createdAt: '' }

function seeded() {
  const index = new Index(':memory:')
  index.upsertNote(meta(A, '2026-10-30T03:42:00.000Z'), transcript(TRANSCRIPT), digestA, 'notes/a.md')
  index.upsertNote(meta(B, '2026-10-28T10:00:00.000Z'), transcript('Thinking about the garden and tomatoes this weekend, nothing else.'), null, 'notes/b.md')
  return index
}

describe('search', () => {
  it('finds words, with prefix matching and stemming', () => {
    const index = seeded()
    expect(index.search('bank').map(hit => hit.ref)).toEqual([A])
    expect(index.search('revie').map(hit => hit.ref)).toEqual([A])
    expect(index.search('tomato').map(hit => hit.ref)).toEqual([B])
    expect(index.search('reminding').length).toBe(1) // porter stemming: remind ~ reminding
  })
  it('needs every word, but widens to any word when nothing matches all of them', () => {
    const index = seeded()
    expect(index.search('bank garden').map(hit => hit.ref).sort()).toEqual([A, B].sort())
    expect(index.search('garden tomatoes').map(hit => hit.ref)).toEqual([B])
  })
  it('returns snippets with dates and survives hostile input', () => {
    const index = seeded()
    const [hit] = index.search('bank')
    expect(hit).toMatchObject({ kind: 'note', day: '2026-10-30', time: '09:12' })
    expect(hit?.snippet).toContain('«bank»')
    for (const query of ['"', 'NEAR(', 'a OR b AND', '*', "'; DROP TABLE notes; --", '', '   ']) expect(() => index.search(query)).not.toThrow()
    expect(index.noteCount()).toBe(2)
  })
  it('weights titles above body text', () => {
    const index = new Index(':memory:')
    index.upsertNote(meta(A, '2026-10-30T03:42:00.000Z', 'Passport renewal'), transcript('Some words about boring things and also the passport once.'), null, 'a.md')
    index.upsertNote(meta(B, '2026-10-29T03:42:00.000Z', 'Garden'), transcript('passport passport passport mentioned inside a long garden ramble about nothing at all really.'), null, 'b.md')
    // no digest, so the title is the note's own title
    expect(index.search('passport')[0]?.ref).toBe(A)
  })
  it('searches wiki pages and can filter by kind', () => {
    const index = seeded()
    index.upsertWiki('wiki/trapper.md', 'Trapper', '# Trapper\nTime budgeting app with a weekly review.', '2026-10-30')
    expect(index.search('budgeting')[0]).toMatchObject({ kind: 'wiki', ref: 'wiki/trapper.md' })
    expect(index.search('weekly', 10, 'note').every(hit => hit.kind === 'note')).toBe(true)
    index.removeWiki('wiki/trapper.md')
    expect(index.search('budgeting')).toEqual([])
  })
})

describe('tasks and entities', () => {
  it('lists open tasks and overlays status', () => {
    const index = seeded()
    expect(index.openTasks().map(task => task.text)).toEqual(['Call the bank'])
    index.setTaskStatus(`${A}#0`, 'done', '2026-10-30')
    expect(index.openTasks()).toEqual([])
    expect(index.task(`${A}#0`)?.status).toBe('done')
    expect(index.taskStatuses(A).get(0)).toBe('done')
    index.loadTaskStatuses({})
    expect(index.openTasks()).toHaveLength(1)
  })
  it('keeps statuses when a note is re-indexed', () => {
    const index = seeded()
    index.setTaskStatus(`${A}#0`, 'done', 'x')
    index.upsertNote(meta(A, '2026-10-30T03:42:00.000Z'), transcript(TRANSCRIPT), digestA, 'notes/a.md')
    expect(index.openTasks()).toEqual([])
  })
  it('orders by due date, undated last', () => {
    const index = new Index(':memory:')
    const digest = { ...digestA, tasks: [
      { text: 'undated', due: null, project: null, priority: 'normal' as const, quote: 'q' },
      { text: 'later', due: '2026-12-01', project: 'Trapper', priority: 'normal' as const, quote: 'q' },
      { text: 'sooner', due: '2026-11-01', project: null, priority: 'high' as const, quote: 'q' },
    ] }
    index.upsertNote(meta(A, '2026-10-30T03:42:00.000Z'), transcript(TRANSCRIPT), digest, 'a.md')
    expect(index.openTasks().map(task => task.text)).toEqual(['sooner', 'later', 'undated'])
    expect(index.openTasks('trapper').map(task => task.text)).toEqual(['later'])
  })
  it('tracks people and projects, and suggests known names', () => {
    const index = seeded()
    expect(index.mentions('project', 'trapper')).toHaveLength(1)
    expect(index.knownEntities()).toEqual({ projects: ['Trapper'], people: ['Nimal'] })
    expect(index.entitiesMatching('how is trapper going')[0]).toMatchObject({ kind: 'project', slug: 'trapper' })
    index.upsertNote(meta(A, '2026-10-30T03:42:00.000Z'), transcript(TRANSCRIPT), { ...digestA, projects: [], people: [], tasks: [] }, 'a.md')
    expect(index.mentions('project', 'trapper')).toHaveLength(0)
  })
  it('resolves short ids and refuses ambiguous ones', () => {
    const index = seeded()
    expect(index.resolveId('11111111')).toBe(A)
    expect(index.resolveId(B)).toBe(B)
    expect(index.resolveId('nope')).toBeNull()
    expect(index.resolveId('')).toBeNull()
  })
  it('lists recent notes newest first', () => {
    expect(seeded().recent('2026-10-01', 10).map(note => note.id)).toEqual([A, B])
    expect(seeded().recent('2026-10-29', 10).map(note => note.id)).toEqual([A])
  })
})
