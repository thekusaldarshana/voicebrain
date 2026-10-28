import { describe, expect, it } from 'vitest'
import { extensionFor, pickMime } from '../src/lib/mime'
import { isConfigured, normalizeEndpoint, parsePairing } from '../src/lib/endpoint'
import { classifyStatus, retryDelayMs, uploadTimeoutMs } from '../src/lib/rules'

describe('upload rules', () => {
  it('treats success and "already stored" as done', () => {
    for (const status of [200, 201, 204, 409]) expect(classifyStatus(status)).toBe('ok')
  })
  it('retries what may heal and stops on what will not', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) expect(classifyStatus(status)).toBe('retry')
    for (const status of [400, 401, 403, 404, 413, 415, 422]) expect(classifyStatus(status)).toBe('permanent')
  })
  it('backs off exponentially, capped at 15 minutes, with jitter', () => {
    const middle = () => 0.5
    expect(retryDelayMs(1, middle)).toBe(5000)
    expect(retryDelayMs(2, middle)).toBe(10_000)
    expect(retryDelayMs(3, middle)).toBe(20_000)
    expect(retryDelayMs(30, middle)).toBe(900_000)
    expect(retryDelayMs(1, () => 0)).toBe(4000)
    expect(retryDelayMs(1, () => 1)).toBe(6000)
  })
  it('honours Retry-After but never beyond an hour', () => {
    expect(retryDelayMs(1, () => 0.5, 120)).toBe(120_000)
    expect(retryDelayMs(1, () => 0.5, 99_999)).toBe(3_600_000)
  })
  it('allows slow connections more time for bigger files', () => {
    expect(uploadTimeoutMs(0)).toBe(60_000)
    expect(uploadTimeoutMs(10_000_000)).toBe(260_000)
    expect(uploadTimeoutMs(10 ** 12)).toBe(900_000)
  })
})

describe('mime', () => {
  it('prefers opus in webm, then mp4 for Safari', () => {
    expect(pickMime(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickMime(mime => mime.startsWith('audio/mp4'))).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(pickMime(() => false)).toBe('')
  })
  it('maps types to file extensions', () => {
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm')
    expect(extensionFor('audio/mp4')).toBe('m4a')
    expect(extensionFor('audio/x-m4a')).toBe('m4a')
    expect(extensionFor('application/unknown')).toBe('bin')
  })
})

describe('server address', () => {
  it('adds a scheme and removes trailing slashes', () => {
    expect(normalizeEndpoint('notes.example.com/')).toBe('https://notes.example.com')
    expect(normalizeEndpoint(' https://notes.example.com/api// ')).toBe('https://notes.example.com/api')
  })
  it('uses http for private networks', () => {
    expect(normalizeEndpoint('192.168.1.20:8787')).toBe('http://192.168.1.20:8787')
    expect(normalizeEndpoint('localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeEndpoint('pi.local')).toBe('http://pi.local')
    expect(normalizeEndpoint('172.20.0.5')).toBe('http://172.20.0.5')
    expect(normalizeEndpoint('172.32.0.5')).toBe('https://172.32.0.5')
    expect(normalizeEndpoint('110.example.com')).toBe('https://110.example.com')
    expect(normalizeEndpoint('192.168.evil.com')).toBe('https://192.168.evil.com')
  })
  it('rejects nonsense', () => {
    expect(normalizeEndpoint('')).toBe('')
    expect(normalizeEndpoint('http://')).toBe('')
    expect(isConfigured({ endpoint: '' })).toBe(false)
    expect(isConfigured({ endpoint: 'notes.example.com' })).toBe(true)
  })
  it('reads pairing links from the fragment', () => {
    expect(parsePairing('#/pair?e=https%3A%2F%2Fnotes.example.com&t=abc123&n=Pixel')).toEqual({ endpoint: 'https://notes.example.com', token: 'abc123', deviceName: 'Pixel' })
    expect(parsePairing('#/pair?t=abc')).toBeNull()
    expect(parsePairing('#/settings')).toBeNull()
  })
})
