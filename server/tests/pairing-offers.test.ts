import { beforeEach, describe, expect, it } from 'vitest'
import { Devices } from '../src/devices.ts'
import { Pairing, PairingError } from '../src/pairing.ts'

const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/
const catching = (run: () => unknown) => { try { run() } catch (error) { return error as PairingError } return null }

describe('pairing from a device that is already connected (the logic)', () => {
  let now = 1_000_000
  let devices: Devices
  let active: Set<string>
  let pairing: Pairing
  beforeEach(() => {
    now = 1_000_000
    devices = new Devices(':memory:', () => now)
    active = new Set(['alice', 'bob'])
    pairing = new Pairing({ devices, publicUrl: 'https://vb.test', isActive: id => active.has(id), now: () => now })
  })

  it('makes an 8-character code in the usual format that lasts two minutes', () => {
    const offer = pairing.offer('alice')
    expect(offer.userCode).toMatch(CODE)
    expect(offer.expiresIn).toBe(120)
    now += 119_000
    expect(pairing.offerStatus(offer.offerId, 'alice')).toBe('pending')
    now += 2_000
    expect(pairing.offerStatus(offer.offerId, 'alice')).toBe('expired')
  })

  it('refuses a code once its two minutes are up, and the refusal counts as a wrong guess', () => {
    const offer = pairing.offer('alice')
    now += 121_000
    expect(catching(() => pairing.claim(offer.userCode, 'Tablet', '', '1.1.1.1'))).toMatchObject({ status: 400 })
    expect(devices.list()).toEqual([])
  })

  it('hands over one token, for the person who made the offer, and never again', () => {
    const offer = pairing.offer('alice')
    const claimed = pairing.claim(offer.userCode.toLowerCase(), '  Tablet\n', 'Firefox', '1.1.1.1')
    expect(claimed.token).toMatch(/^vbd_/)
    expect(devices.verify(claimed.token)).toMatchObject({ name: 'Tablet', userId: 'alice' })
    expect(pairing.offerStatus(offer.offerId, 'alice')).toBe('claimed')
    expect(catching(() => pairing.claim(offer.userCode, 'Again', '', '1.1.1.1'))).toMatchObject({ status: 400 })
    expect(devices.list()).toHaveLength(1)
  })

  it('names the device "New device" when it gives no name, and strips control characters', () => {
    expect(devices.verify(pairing.claim(pairing.offer('alice').userCode, '', '', '1.1.1.1').token)?.name).toBe('New device')
    expect(devices.verify(pairing.claim(pairing.offer('alice').userCode, 'a\u0007b', '', '1.1.1.1').token)?.name).toBe('a b')
  })

  it('allows five wrong codes per address in ten minutes, then refuses even the right code', () => {
    const offer = pairing.offer('alice')
    for (let n = 0; n < 5; n += 1) expect(catching(() => pairing.claim(`ZZZZ-ZZZ${n + 2}`, 'x', '', '9.9.9.9'))).toMatchObject({ status: 400 })
    expect(catching(() => pairing.claim(offer.userCode, 'x', '', '9.9.9.9'))).toMatchObject({ status: 429 })
    now += 11 * 60_000 // ten minutes later the address is forgiven; the code, though, has long since expired
    expect(catching(() => pairing.claim(offer.userCode, 'x', '', '9.9.9.9'))).toMatchObject({ status: 400 })
    const fresh = pairing.offer('alice')
    expect(pairing.claim(fresh.userCode, 'x', '', '9.9.9.9').token).toBeTruthy()
  })

  it('does not let a different address off the hook, and a wrong guess by one address does not block another', () => {
    const offer = pairing.offer('alice')
    for (let n = 0; n < 5; n += 1) catching(() => pairing.claim('ZZZZ-ZZZZ', 'x', '', '9.9.9.9'))
    expect(pairing.claim(offer.userCode, 'x', '', '8.8.8.8').token).toBeTruthy()
  })

  it('stops everyone for a while after thirty wrong codes from many addresses', () => {
    const offer = pairing.offer('alice')
    for (let n = 0; n < 30; n += 1) catching(() => pairing.claim('ZZZZ-ZZZZ', 'x', '', `10.0.0.${n}`))
    expect(catching(() => pairing.claim(offer.userCode, 'x', '', '10.9.9.9'))).toMatchObject({ status: 429 })
    now += 61 * 60_000
    expect(catching(() => pairing.claim(pairing.offer('alice').userCode, 'x', '', '10.9.9.9'))).toBeNull()
  })

  it('treats a malformed code like any wrong code', () => {
    pairing.offer('alice')
    for (const input of ['', '1234', 'ABCD', 'ABCD-EFGH-JKMN', '********']) expect(catching(() => pairing.claim(input, 'x', '', '3.3.3.3'))).toMatchObject({ status: 400 })
  })

  it('shows at most three codes per person at a time, and frees a slot when one is used or expires', () => {
    const codes = [pairing.offer('alice'), pairing.offer('alice'), pairing.offer('alice')]
    expect(new Set(codes.map(code => code.userCode)).size).toBe(3)
    expect(catching(() => pairing.offer('alice'))).toMatchObject({ status: 429 })
    expect(pairing.offer('bob').userCode).toMatch(CODE) // somebody else is not affected
    pairing.claim((codes[0] as { userCode: string }).userCode, 'x', '', '1.1.1.1')
    expect(catching(() => pairing.offer('alice'))).toBeNull()
    now += 121_000
    expect(catching(() => pairing.offer('alice'))).toBeNull()
  })

  it('does not tell another person whether a code was used', () => {
    const offer = pairing.offer('alice')
    expect(pairing.offerStatus(offer.offerId, 'bob')).toBe('expired')
    expect(pairing.offerStatus('11111111-1111-4111-8111-111111111111', 'alice')).toBe('expired')
  })

  it('refuses a code whose person has since lost access', () => {
    const offer = pairing.offer('bob')
    active.delete('bob')
    expect(catching(() => pairing.claim(offer.userCode, 'x', '', '1.1.1.1'))).toMatchObject({ status: 400 })
    expect(devices.list()).toEqual([])
  })

  it('is a different list from the codes new devices show, so the two directions cannot be confused', () => {
    const offer = pairing.offer('alice')
    const asking = pairing.start('Pixel', '', '2.2.2.2')
    expect(pairing.approve(offer.userCode, true, 'alice')).toEqual({ ok: false, reason: 'unknown' })
    expect(catching(() => pairing.claim(asking.userCode, 'x', '', '1.1.1.1'))).toMatchObject({ status: 400 })
  })
})

describe('approving from a signed-in session (the logic)', () => {
  let now = 1_000_000
  let devices: Devices
  let pairing: Pairing
  beforeEach(() => { now = 1_000_000; devices = new Devices(':memory:', () => now); pairing = new Pairing({ devices, publicUrl: 'https://vb.test', now: () => now }) })

  it('creates the device for the person who approved, and only before the ten minutes are up', () => {
    const fresh = pairing.start('Pixel', 'Chrome', '1.1.1.1')
    expect(pairing.approve(fresh.userCode, true, 'alice')).toEqual({ ok: true, deviceName: 'Pixel' })
    const done = pairing.poll(fresh.pairId, fresh.pollToken)
    expect(devices.verify((done as { token: string }).token)?.userId).toBe('alice')
    const stale = pairing.start('Laptop', '', '1.1.1.2')
    now += 11 * 60_000
    expect(pairing.approve(stale.userCode, true, 'alice')).toEqual({ ok: false, reason: 'unknown' })
    expect(devices.list()).toHaveLength(1)
  })

  it('has no passphrase to guess when none is configured: the legacy path refuses everything, even an empty one', () => {
    const { userCode } = pairing.start('Pixel', '', '1.1.1.1')
    expect(pairing.decide(userCode, true, '', '2.2.2.2')).toEqual({ ok: false, reason: 'wrong-passphrase' })
    expect(devices.list()).toEqual([])
  })
})
