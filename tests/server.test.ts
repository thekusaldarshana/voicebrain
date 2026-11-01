import { describe, expect, it } from 'vitest'
import { PairingUnavailable, ServerError, authHeaders, deleteOnServer, disconnectThisDevice, editOnServer, fetchAccount, pollPairing, startPairing } from '../src/lib/server'

const settings = { endpoint: 'vb.example.com/', token: 'vbd_secret' }
type Seen = { url: string; method?: string; headers: Record<string, string>; body?: string }
const fakeFetch = (status: number, body: unknown = {}) => {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => { seen.push({ url, ...(init.method ? { method: init.method } : {}), headers: init.headers as Record<string, string>, ...(init.body ? { body: String(init.body) } : {}) }); return new Response(status === 204 ? null : JSON.stringify(body), { status }) }) as unknown as typeof fetch
  return { fetchImpl, seen }
}
const broken = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch

describe('talking to the server', () => {
  it('sends the device token as a bearer token, and nothing when there is none', () => {
    expect(authHeaders({ token: 'abc' })).toEqual({ Authorization: 'Bearer abc' })
    expect(authHeaders({ token: '' })).toEqual({})
  })

  it('deletes a note, treating "already gone" as done', async () => {
    const ok = fakeFetch(204)
    await deleteOnServer(settings, '3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b', ok.fetchImpl)
    expect(ok.seen[0]).toMatchObject({ url: 'https://vb.example.com/v1/notes/3f2b1c0e-8a41-4d7e-9b52-0c6d1e2f3a4b', method: 'DELETE', headers: { Authorization: 'Bearer vbd_secret' } })
    await expect(deleteOnServer(settings, 'x', fakeFetch(404).fetchImpl)).resolves.toBeUndefined()
  })

  it('explains a refusal or an outage in plain words, and never claims it deleted something it did not', async () => {
    await expect(deleteOnServer(settings, 'x', fakeFetch(401).fetchImpl)).rejects.toThrow(/no longer connected/)
    await expect(deleteOnServer(settings, 'x', fakeFetch(500).fetchImpl)).rejects.toThrow(/answered 500/)
    await expect(deleteOnServer(settings, 'x', broken)).rejects.toThrow(/Could not reach the server/)
    await expect(deleteOnServer({ endpoint: '', token: '' }, 'x', fakeFetch(204).fetchImpl)).rejects.toThrow(/No server/)
    const error = await deleteOnServer(settings, 'x', fakeFetch(403).fetchImpl).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ServerError)
    expect((error as ServerError).status).toBe(403)
  })

  it('sends a rename with the tags, and reports a note the server does not have', async () => {
    const ok = fakeFetch(200, { ok: true })
    expect(await editOnServer(settings, 'abc', { title: 'New name', tags: ['a'] }, ok.fetchImpl)).toBe('ok')
    expect(ok.seen[0]).toMatchObject({ method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer vbd_secret' } })
    expect(JSON.parse(ok.seen[0]?.body as string)).toEqual({ title: 'New name', tags: ['a'] })
    expect(await editOnServer(settings, 'abc', { title: 'x', tags: [] }, fakeFetch(404).fetchImpl)).toBe('gone')
    await expect(editOnServer(settings, 'abc', { title: 'x', tags: [] }, fakeFetch(401).fetchImpl)).rejects.toThrow(/no longer connected/)
  })

  it('starts pairing without any token, and tells "not set up" apart from "try later"', async () => {
    const start = { pairId: 'p', userCode: 'ABCD-EFGH', pollToken: 't', verificationUrl: 'https://vb.example.com/pair?code=ABCD-EFGH', expiresIn: 600, interval: 2 }
    const ok = fakeFetch(200, start)
    expect(await startPairing('vb.example.com', 'My phone', undefined, ok.fetchImpl)).toEqual(start)
    expect(ok.seen[0]?.headers.Authorization).toBeUndefined()
    expect(JSON.parse(ok.seen[0]?.body as string)).toEqual({ deviceName: 'My phone' })
    await expect(startPairing('vb.example.com', 'x', undefined, fakeFetch(501).fetchImpl)).rejects.toBeInstanceOf(PairingUnavailable)
    await expect(startPairing('vb.example.com', 'x', undefined, fakeFetch(429, { error: 'Too many pairing requests from this address. Try again later.' }).fetchImpl)).rejects.toThrow(/Too many pairing requests/)
  })

  it('polls with the secret it was given', async () => {
    const waiting = fakeFetch(200, { status: 'pending' })
    expect(await pollPairing('vb.example.com', { pairId: 'p', pollToken: 'secret' }, undefined, waiting.fetchImpl)).toEqual({ status: 'pending' })
    expect(JSON.parse(waiting.seen[0]?.body as string)).toEqual({ pairId: 'p', pollToken: 'secret' })
    await expect(pollPairing('vb.example.com', { pairId: 'p', pollToken: 's' }, undefined, fakeFetch(500).fetchImpl)).rejects.toThrow(/answered 500/)
  })

  it('disconnects this device on the server, and never fails the local disconnect', async () => {
    const ok = fakeFetch(204)
    await disconnectThisDevice({ ...settings, deviceId: 'dev-9' }, ok.fetchImpl)
    expect(ok.seen[0]).toMatchObject({ url: 'https://vb.example.com/v1/devices/dev-9', method: 'DELETE' })
    await expect(disconnectThisDevice({ ...settings, deviceId: 'dev-9' }, broken)).resolves.toBeUndefined()
    const none = fakeFetch(204)
    await disconnectThisDevice({ ...settings, deviceId: '' }, none.fetchImpl) // a hand-pasted token has no device id
    expect(none.seen).toHaveLength(0)
  })
})

describe('who this device is signed in as', () => {
  const answering = (routes: Record<string, { status: number; body: unknown }>) => (async (url: string) => {
    const hit = routes[new URL(url).pathname]
    return hit ? new Response(JSON.stringify(hit.body), { status: hit.status }) : new Response('{}', { status: 404 })
  }) as unknown as typeof fetch

  it('reads the account and the Drive state', async () => {
    const fetchImpl = answering({ '/v1/me': { status: 200, body: { account: { email: 'a@b.c', name: 'A' } } }, '/v1/drive': { status: 200, body: { enabled: true, connected: false, canConnect: true } } })
    expect(await fetchAccount(settings, fetchImpl)).toEqual({ account: { email: 'a@b.c', name: 'A' }, drive: { enabled: true, connected: false, canConnect: true } })
  })

  it('has no account for a device connected the old way, and nothing to offer when Drive is off', async () => {
    const fetchImpl = answering({ '/v1/me': { status: 200, body: { account: null } }, '/v1/drive': { status: 200, body: { enabled: false, connected: false, canConnect: false } } })
    expect(await fetchAccount(settings, fetchImpl)).toEqual({ account: null, drive: { enabled: false, connected: false, canConnect: false } })
  })

  it('says nothing rather than guess when the server refuses or cannot be reached', async () => {
    expect(await fetchAccount(settings, answering({ '/v1/me': { status: 401, body: {} } }))).toBeNull()
    expect(await fetchAccount(settings, broken)).toBeNull()
  })

  it('still shows the account when only the Drive answer is missing', async () => {
    expect(await fetchAccount(settings, answering({ '/v1/me': { status: 200, body: { account: { email: 'a@b.c' } } } }))).toEqual({ account: { email: 'a@b.c', name: 'a@b.c' }, drive: { enabled: false, connected: false, canConnect: false } })
  })
})
