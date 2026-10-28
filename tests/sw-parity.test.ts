import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { extensionFor } from '../src/lib/mime'
import { normalizeEndpoint } from '../src/lib/endpoint'
import { classifyStatus, retryDelayMs, statusMessage, uploadTimeoutMs } from '../src/lib/rules'

// public/sw.js cannot import the app's modules, so it carries copies. These tests fail if they disagree.
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const sw = runInNewContext(`${source}\n;({ classifyStatus, retryDelayMs, uploadTimeoutMs, statusMessage, extensionFor, normalizeEndpoint })`, {
  self: { addEventListener() {}, location: { origin: 'https://voice.test' } },
  URL, Date, Math, Set, Promise, Intl,
}) as Record<string, (...args: unknown[]) => unknown>

describe('service worker matches the app', () => {
  it('classifies every status the same way', () => {
    for (let status = 100; status < 600; status += 1) expect(sw.classifyStatus(status), String(status)).toBe(classifyStatus(status))
  })
  it('words every error the same way', () => {
    for (const status of [400, 401, 403, 404, 413, 415, 422, 429, 500, 503, 418]) expect(sw.statusMessage(status)).toBe(statusMessage(status))
  })
  it('computes the same retry delays', () => {
    for (const random of [0, 0.5, 1]) for (let attempts = 0; attempts < 14; attempts += 1) for (const after of [0, 30, 99_999]) {
      expect(sw.retryDelayMs(attempts, () => random, after), `${attempts}/${random}/${after}`).toBe(retryDelayMs(attempts, () => random, after))
    }
  })
  it('computes the same timeouts', () => {
    for (const size of [0, 1, 49_999, 50_000, 10_000_000, 10 ** 12]) expect(sw.uploadTimeoutMs(size)).toBe(uploadTimeoutMs(size))
  })
  it('names files and addresses the same way', () => {
    for (const mime of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/flac', 'text/plain', '']) expect(sw.extensionFor(mime)).toBe(extensionFor(mime))
    for (const text of ['', 'notes.example.com/', 'https://a.test/x//', '192.168.1.2:8787', 'localhost:1', 'pi.local', 'http://', 'a b']) expect(sw.normalizeEndpoint(text), text).toBe(normalizeEndpoint(text))
  })
})
