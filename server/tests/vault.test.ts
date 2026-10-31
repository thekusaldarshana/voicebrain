import { describe, expect, it } from 'vitest'
import type { NoteMeta, Transcript } from '../src/types.ts'
import { notePath, paragraphs, renderNote, renderTasks, wikiLink, wordsAt } from '../src/vault.ts'
import { formatClock, localParts, slugify } from '../src/util.ts'
import type { TaskRow } from '../src/index.ts'
import { DIGEST, TRANSCRIPT } from './helpers.ts'
import { cleanDigest } from '../src/digest.ts'

const meta: NoteMeta = { id: '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b', createdAt: '2026-10-30T03:42:00.000Z', durationMs: 10_500, mime: 'audio/webm', size: 4, title: '', tags: ['inbox'], marks: [8000], recovered: false, source: 'record', device: 'Pixel', timezone: 'Asia/Colombo', utcOffsetMinutes: 330, app: 'x', receivedAt: '', audioFile: 'audio.webm', audioBytes: 4 }
const transcript: Transcript = { text: TRANSCRIPT, language: 'en', durationSec: 10.5, model: 'whisper', suspectedSilence: false, createdAt: '', segments: [
  { start: 0, end: 3, text: 'Remind me to call the bank tomorrow.' }, { start: 3.5, end: 6.5, text: 'I also had an idea about the Trapper app.' }, { start: 9.5, end: 12, text: 'Maybe a weekly review screen.' },
] }
const digest = { ...cleanDigest(DIGEST, TRANSCRIPT), model: 'm', createdAt: '' }

describe('time and names', () => {
  it('uses the time where the note was recorded', () => {
    expect(localParts('2026-10-30T03:42:00.000Z', 330)).toEqual({ date: '2026-10-30', time: '09:12', weekday: 'Friday', offset: '+05:30' })
    expect(localParts('2026-10-30T23:30:00.000Z', 330).date).toBe('2026-10-31')
    expect(localParts('2026-10-30T01:00:00.000Z', -300)).toMatchObject({ date: '2026-10-29', time: '20:00', offset: '-05:00' })
  })
  it('gives each note a stable path that does not depend on its title', () => {
    expect(notePath(meta)).toBe('notes/2026/10/2026-10-30-0912-3f2b1c0e.md')
    expect(notePath({ ...meta })).toBe(notePath(meta))
  })
  it('makes safe slugs', () => {
    expect(slugify('Café: Trapper v2!')).toBe('cafe-trapper-v2')
    expect(slugify('???')).toBe('untitled')
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(48)
    expect(formatClock(65)).toBe('01:05')
    expect(wikiLink('wiki/a.md', 'A | B')).toBe('[[wiki/a|A  B]]')
  })
})

describe('reading the transcript', () => {
  it('breaks paragraphs at pauses', () => { expect(paragraphs(transcript)).toEqual(['Remind me to call the bank tomorrow. I also had an idea about the Trapper app.', 'Maybe a weekly review screen.']) })
  it('finds the words around a marked moment', () => {
    expect(wordsAt(transcript.segments, 1)).toBe('Remind me to call the bank tomorrow.')
    expect(wordsAt(transcript.segments, 10)).toBe('Maybe a weekly review screen.')
    expect(wordsAt(transcript.segments, 8)).toBe('Maybe a weekly review screen.') // in the gap: the nearest segment
    expect(wordsAt([], 5)).toBeNull()
  })
})

describe('the note file', () => {
  const text = renderNote(meta, transcript, digest, new Map([[0, 'done' as const]]))
  it('has frontmatter, summary, tasks with their quotes, and the transcript', () => {
    expect(text).toMatch(/^---\nid: "3f2b1c0e/)
    expect(text).toContain('recorded: "2026-10-30T09:12:00+05:30"')
    expect(text).toContain('digested: true')
    expect(text).toContain('# Bank call and weekly review idea')
    expect(text).toContain('- [x] Call the bank · due 2026-10-31')
    expect(text).toContain('> “Remind me to call the bank tomorrow”')
    expect(text).toContain('## Ideas')
    expect(text).toContain('[[projects/trapper|Trapper]]')
    expect(text).toContain('## Transcript')
  })
  it('puts the words next to each marked moment', () => { expect(text).toContain('`00:08` “Maybe a weekly review screen.”') })
  it('says plainly what it left out', () => { expect(text).toContain('1 extracted item(s) left out because they could not be matched to spoken words') })
  it('is honest before the digest exists', () => {
    const early = renderNote(meta, transcript, null, new Map())
    expect(early).toContain('digested: false')
    expect(early).toContain('Summary and tasks have not been extracted yet')
    expect(early).toContain('Remind me to call the bank tomorrow.')
  })
  it('warns about a probably empty recording', () => {
    expect(renderNote(meta, { ...transcript, suspectedSilence: true }, null, new Map())).toContain('Possibly no speech')
  })
  it('keeps hostile text inside YAML strings', () => {
    const evil = renderNote({ ...meta, tags: ['a"\nkind: injected'] }, transcript, null, new Map())
    expect(evil).toContain('tags: ["a\\"\\nkind: injected"]')
  })
})

describe('the open tasks view', () => {
  const row = (text: string, due: string | null): TaskRow => ({ id: text, note_id: 'n', idx: 0, text, due, project: null, priority: 'normal', quote: '', recorded_at: '', status: 'open', note_title: 't', day: '2026-10-30' })
  it('groups by urgency', () => {
    const view = renderTasks([row('late', '2026-10-01'), row('soon', '2026-11-02'), row('later', '2027-01-01'), row('someday', null)], '2026-10-31')
    const order = ['## Overdue', 'late', '## Next seven days', 'soon', '## Later', 'later', '## No date', 'someday'].map(part => view.indexOf(part))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(renderTasks([], '2026-10-31')).toContain('Nothing open.')
  })
})
