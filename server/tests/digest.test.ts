import { describe, expect, it } from 'vitest'
import { anchorQuote, chatJson, chunkText, cleanDigest, digestNote, extractJson, normalize } from '../src/digest.ts'
import type { Config } from '../src/config.ts'
import type { NoteMeta, Transcript } from '../src/types.ts'
import { DIGEST, TRANSCRIPT, fakeLlm } from './helpers.ts'

describe('quote anchoring', () => {
  it('accepts a quote that was spoken, ignoring case and punctuation', () => {
    expect(anchorQuote(TRANSCRIPT, 'remind me to call the bank, tomorrow!')).not.toBeNull()
    expect(anchorQuote(TRANSCRIPT, 'Maybe a weekly review screen')).not.toBeNull()
  })
  it('repairs a paraphrased quote with the closest real sentence', () => {
    const repaired = anchorQuote(TRANSCRIPT, 'I also had an idea about Trapper app')
    expect(repaired).toBe('I also had an idea about the Trapper app.')
  })
  it('rejects a quote that was never said', () => {
    expect(anchorQuote(TRANSCRIPT, 'I must book the dentist for next week')).toBeNull()
    expect(anchorQuote(TRANSCRIPT, '')).toBeNull()
  })
  it('normalizes to lowercase words', () => { expect(normalize('Hello,  World’s — end!')).toBe("hello world's end") })
})

describe('cleaning what the model returned', () => {
  it('keeps supported items, drops invented ones, and counts them', () => {
    const digest = cleanDigest(DIGEST, TRANSCRIPT)
    expect(digest.tasks.map(task => task.text)).toEqual(['Call the bank'])
    expect(digest.ideas).toHaveLength(1)
    expect(digest.droppedItems).toBe(1)
    expect(digest.tags).toEqual(['bank', 'trapper'])
  })
  it('only trusts real calendar dates and known priorities', () => {
    const digest = cleanDigest({ tasks: [
      { text: 'a', due: '2026-02-30', priority: 'URGENT', quote: 'call the bank' },
      { text: 'b', due: 'tomorrow', priority: 'whenever', quote: 'call the bank' },
      { text: 'c', due: '2026-11-05', priority: 'low', quote: 'call the bank' },
    ] }, TRANSCRIPT)
    expect(digest.tasks.map(task => [task.due, task.priority])).toEqual([[null, 'high'], [null, 'normal'], ['2026-11-05', 'low']])
  })
  it('survives garbage', () => {
    for (const raw of [null, 'x', 5, [], { tasks: 'nope', people: [null, 3, { name: '' }] }]) expect(() => cleanDigest(raw, TRANSCRIPT)).not.toThrow()
    expect(cleanDigest({ tasks: 'nope' }, TRANSCRIPT).tasks).toEqual([])
  })
})

describe('reading model replies', () => {
  it('extracts JSON from fences and chatter', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Sure! Here you go: {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } })
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('long transcripts', () => {
  it('splits on sentence boundaries within the limit', () => {
    const text = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i}.`).join(' ')
    const chunks = chunkText(text, 200)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every(chunk => chunk.length <= 200)).toBe(true)
    expect(chunks.join(' ')).toBe(text)
    expect(chunkText('short.', 200)).toEqual(['short.'])
  })
  it('splits a single enormous sentence rather than failing', () => {
    expect(chunkText('x'.repeat(450), 200).map(chunk => chunk.length)).toEqual([200, 200, 50])
  })
})

describe('digesting through a model server', () => {
  const meta = { id: 'a', createdAt: '2026-10-30T03:42:00.000Z', utcOffsetMinutes: 330, timezone: 'Asia/Colombo', title: '' } as NoteMeta
  const transcript = { text: TRANSCRIPT, segments: [] } as unknown as Transcript

  it('sends the recording time and known names, and parses the answer', async () => {
    const llm = await fakeLlm()
    const config = { baseUrl: llm.url, apiKey: 'k', model: 'm', maxInputChars: 20_000 } as NonNullable<Config['llm']>
    const digest = await digestNote(config, meta, transcript, { projects: ['Trapper'], people: ['Nimal'] })
    await llm.close()
    expect(digest.title).toBe(DIGEST.title)
    expect(digest.tasks).toHaveLength(1)
    const prompt = llm.requests[0]?.json.messages[1].content as string
    expect(prompt).toContain('Recorded: 2026-10-30 09:12 (Friday), UTC+05:30')
    expect(prompt).toContain('KNOWN projects: Trapper')
    expect(prompt).toContain(TRANSCRIPT)
    expect(llm.requests[0]?.json.response_format).toEqual({ type: 'json_object' })
  })

  it('merges chunks of a long recording and asks once more for a title', async () => {
    const llm = await fakeLlm({ ...DIGEST, tasks: [{ text: 'Call the bank', due: null, project: null, priority: 'normal', quote: 'call the bank' }] })
    const config = { baseUrl: llm.url, apiKey: '', model: 'm', maxInputChars: 60 } as NonNullable<Config['llm']>
    const digest = await digestNote(config, meta, transcript, { projects: [], people: [] })
    await llm.close()
    expect(llm.requests.length).toBeGreaterThan(2)
    expect(digest.tasks).toHaveLength(1) // the same task found in every chunk is listed once
  })

  it('retries without response_format when the server rejects it', async () => {
    const llm = await fakeLlm()
    llm.respond(index => (index === 0 ? { status: 400, body: { error: 'response_format unsupported' } } : null))
    const config = { baseUrl: llm.url, apiKey: '', model: 'm', maxInputChars: 20_000 } as NonNullable<Config['llm']>
    const result = await chatJson(config, 's', 'u')
    await llm.close()
    expect(result).toMatchObject({ title: DIGEST.title })
    expect(llm.requests[1]?.json.response_format).toBeUndefined()
  })

  it('treats a 401 as permanent and a 503 as retryable', async () => {
    const llm = await fakeLlm()
    const config = { baseUrl: llm.url, apiKey: '', model: 'm', maxInputChars: 20_000 } as NonNullable<Config['llm']>
    llm.respond(() => ({ status: 401, body: { error: 'bad key' } }))
    await expect(chatJson(config, 's', 'u')).rejects.toMatchObject({ constructor: expect.objectContaining({ name: 'PermanentError' }) })
    llm.respond(() => ({ status: 503, body: { error: 'busy' } }))
    const error = await chatJson(config, 's', 'u').catch((caught: Error) => caught)
    await llm.close()
    expect((error as Error).constructor.name).toBe('Error')
  })
})
