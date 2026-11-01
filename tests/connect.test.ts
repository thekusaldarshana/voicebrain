import { describe, expect, it } from 'vitest'
import { connectDevice, type ConnectState } from '../src/lib/connect'

const START = { pairId: 'pair-1', userCode: 'K7QM-4XPD', pollToken: 'secret-poll', verificationUrl: 'https://vb.test/pair?code=K7QM-4XPD', expiresIn: 600, interval: 2 }
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A server whose answers to polling are given in order. The last one repeats. */
function fakeServer(polls: Array<Response | Error>, start: Response | Error = reply(200, START)) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = []
  let poll = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> })
    const answer = url.endsWith('/v1/pair/start') ? start : (polls[Math.min(poll++, polls.length - 1)] as Response | Error)
    if (answer instanceof Error) throw answer
    return answer.clone()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const run = async (server: ReturnType<typeof fakeServer>, options: { abortAfterSleeps?: number; clock?: () => number } = {}) => {
  const states: ConnectState[] = []
  const controller = new AbortController()
  let sleeps = 0
  const sleeps_: number[] = []
  const result = await connectDevice('vb.test', 'Pixel', state => states.push(state), controller.signal, {
    fetchImpl: server.fetchImpl,
    sleep: async ms => { sleeps_.push(ms); sleeps += 1; if (options.abortAfterSleeps !== undefined && sleeps >= options.abortAfterSleeps) controller.abort() },
    ...(options.clock ? { now: options.clock } : {}),
  })
  return { result, states, sleeps: sleeps_ }
}

describe('connecting a device', () => {
  it('asks for a code, shows it, waits, and returns the credentials once approved', async () => {
    const server = fakeServer([reply(200, { status: 'pending' }), reply(200, { status: 'pending' }), reply(200, { status: 'approved', token: 'vbd_token', deviceId: 'dev-1', endpoint: 'https://vb.test' })])
    const { result, states, sleeps } = await run(server)
    expect(result).toEqual({ endpoint: 'https://vb.test', token: 'vbd_token', deviceId: 'dev-1' })
    expect(states.map(state => state.phase)).toEqual(['starting', 'waiting'])
    expect(states[1]).toMatchObject({ phase: 'waiting', code: 'K7QM-4XPD', url: 'https://vb.test/pair?code=K7QM-4XPD' })
    expect(sleeps).toEqual([2000, 2000]) // polls at the pace the server asked for
    expect(server.calls[0]).toMatchObject({ url: 'https://vb.test/v1/pair/start', method: 'POST', body: { deviceName: 'Pixel' } })
    expect(server.calls[1]).toMatchObject({ url: 'https://vb.test/v1/pair/poll', body: { pairId: 'pair-1', pollToken: 'secret-poll' } })
    expect(server.calls.every(call => !call.headers.Authorization)).toBe(true) // no token exists yet, and none is sent
  })

  it('falls back to the address it asked when the server does not name one', async () => {
    const server = fakeServer([reply(200, { status: 'approved', token: 'vbd_t', deviceId: 'd', endpoint: '' })])
    expect((await run(server)).result?.endpoint).toBe('https://vb.test')
  })

  it('says so when the owner denies it, or the code expires on the server', async () => {
    const denied = await run(fakeServer([reply(200, { status: 'denied' })]))
    expect(denied.result).toBeNull()
    expect(denied.states.at(-1)).toMatchObject({ phase: 'failed', reason: 'denied' })
    const expired = await run(fakeServer([reply(200, { status: 'expired' })]))
    expect(expired.states.at(-1)).toMatchObject({ phase: 'failed', reason: 'expired' })
  })

  it('gives up when the code runs out while still waiting', async () => {
    let now = 0
    const server = fakeServer([reply(200, { status: 'pending' })])
    const { result, states } = await run(server, { clock: () => { now += 200_000; return now } })
    expect(result).toBeNull()
    expect(states.at(-1)).toMatchObject({ phase: 'failed', reason: 'expired' })
  })

  it('points to the manual way when the server cannot do one-tap connecting', async () => {
    const { result, states } = await run(fakeServer([], reply(501, { error: 'not set up' })))
    expect(result).toBeNull()
    expect(states.at(-1)).toMatchObject({ phase: 'failed', reason: 'unavailable' })
    expect((states.at(-1) as { message: string }).message).toMatch(/Advanced/)
  })

  it('reports an unreachable server instead of waiting forever', async () => {
    const { result, states } = await run(fakeServer([], new TypeError('fetch failed')))
    expect(result).toBeNull()
    expect(states.at(-1)).toMatchObject({ phase: 'failed', reason: 'network' })
    expect((states.at(-1) as { message: string }).message).toContain('Could not reach the server')
  })

  it('puts up with a few dropped polls but not a dead connection', async () => {
    const blip = new TypeError('network changed')
    const recovered = await run(fakeServer([blip, blip, reply(200, { status: 'approved', token: 'vbd_t', deviceId: 'd', endpoint: 'https://vb.test' })]))
    expect(recovered.result?.token).toBe('vbd_t')
    const dead = await run(fakeServer([blip]))
    expect(dead.result).toBeNull()
    expect(dead.states.at(-1)).toMatchObject({ phase: 'failed', reason: 'network' })
  })

  it('stops quietly when cancelled', async () => {
    const { result, states } = await run(fakeServer([reply(200, { status: 'pending' })]), { abortAfterSleeps: 2 })
    expect(result).toBeNull()
    expect(states.every(state => state.phase !== 'failed')).toBe(true)
  })
})
