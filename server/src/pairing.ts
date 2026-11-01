import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Devices } from './devices.ts'
import { Throttle } from './oauth.ts'
import { OWNER_ID } from './users.ts'

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no I, L, O, 0 or 1: easy to read off a screen
const SESSION_SECONDS = 600
const MAX_PENDING = 20
const OFFER_SECONDS = 120
const MAX_OFFERS_PER_USER = 3

const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)

export const normalizeCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

interface Offer { id: string; code: string; userId: string; expiresAt: number; claimed: boolean }

const cleanName = (name: string) => name.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 40) || 'New device'

interface Session {
  id: string
  code: string
  pollToken: string
  deviceName: string
  userAgent: string
  ip: string
  expiresAt: number
  status: 'pending' | 'approved' | 'denied'
  token?: string
  deviceId?: string
}

export interface PairStart { pairId: string; userCode: string; pollToken: string; verificationUrl: string; expiresIn: number; interval: number }
export type PairPoll = { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; token: string; deviceId: string }

export interface PairOffer { offerId: string; userCode: string; expiresIn: number }
export type OfferStatus = 'pending' | 'claimed' | 'expired'

export class PairingError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

/**
 * Adds a device without anyone copying a token. Two directions, same code format:
 *
 * - New device asks: the app asks for a code and shows it, a signed-in person confirms that code on the server's
 *   own page (with the legacy owner passphrase instead, when Google sign-in is not configured). The app, which
 *   has been polling, then receives its own token.
 * - Paired device offers: an already-connected app asks for a short-lived code (or QR) and shows it; the new
 *   device types it in and receives a token for the same user. Codes last two minutes, work once, and wrong
 *   guesses are throttled per address and overall.
 *
 * The long-lived token never appears in a link, a QR code or a chat.
 */
export class Pairing {
  private readonly sessions = new Map<string, Session>()
  private readonly starts = new Map<string, number[]>()
  private readonly devices: Devices
  private readonly offers = new Map<string, Offer>()
  private readonly passphrase: string
  private readonly publicUrl: string
  private readonly isActive: (userId: string) => boolean
  private readonly now: () => number
  readonly throttle: Throttle
  /** Wrong codes typed into the new device. Looser overall limit than approvals: strangers can spend it, so it must not lock the owner out for long. */
  readonly claimThrottle: Throttle

  constructor(options: { devices: Devices; passphrase?: string; publicUrl: string; isActive?: (userId: string) => boolean; now?: () => number }) {
    this.devices = options.devices
    this.passphrase = options.passphrase ?? ''
    this.publicUrl = options.publicUrl
    this.isActive = options.isActive ?? (() => true)
    this.now = options.now ?? Date.now
    this.throttle = new Throttle(this.now)
    this.claimThrottle = new Throttle(this.now, { perKey: 5, global: 30 })
  }

  private sweep() {
    for (const [id, session] of this.sessions) if (session.expiresAt < this.now()) this.sessions.delete(id)
    for (const [id, offer] of this.offers) if (offer.expiresAt < this.now()) this.offers.delete(id)
  }

  private newCode(taken: (code: string) => boolean): string {
    let code = ''
    do code = Array.from(randomBytes(8), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
    while (taken(code))
    return code
  }

  start(deviceName: string, userAgent: string, ip: string): PairStart {
    this.sweep()
    const recent = (this.starts.get(ip) ?? []).filter(at => at > this.now() - 3_600_000)
    if (recent.length >= 10) throw new PairingError(429, 'Too many pairing requests from this address. Try again later.')
    if (this.sessions.size >= MAX_PENDING) throw new PairingError(429, 'Too many pairing requests are waiting. Try again in a few minutes.')
    this.starts.set(ip, [...recent, this.now()])
    const code = this.newCode(candidate => [...this.sessions.values()].some(session => session.code === candidate))
    const session: Session = {
      id: randomUUID(), code, pollToken: randomBytes(24).toString('base64url'), deviceName: cleanName(deviceName),
      userAgent: userAgent.slice(0, 200), ip, expiresAt: this.now() + SESSION_SECONDS * 1000, status: 'pending',
    }
    this.sessions.set(session.id, session)
    return { pairId: session.id, userCode: formatCode(code), pollToken: session.pollToken, verificationUrl: `${this.publicUrl}/pair?code=${formatCode(code)}`, expiresIn: SESSION_SECONDS, interval: 2 }
  }

  private byCode(input: string): Session | null {
    this.sweep()
    const code = normalizeCode(input)
    return code.length === 8 ? [...this.sessions.values()].find(session => session.code === code && session.status === 'pending') ?? null : null
  }

  poll(pairId: string, pollToken: string): PairPoll {
    this.sweep()
    const session = this.sessions.get(pairId)
    if (!session || !same(pollToken, session.pollToken)) return { status: 'expired' }
    if (session.status === 'approved' && session.token && session.deviceId) {
      this.sessions.delete(pairId) // the token is handed over once
      return { status: 'approved', token: session.token, deviceId: session.deviceId }
    }
    if (session.status === 'denied') { this.sessions.delete(pairId); return { status: 'denied' } }
    return { status: 'pending' }
  }

  /** What the approval page shows about the request, or null for an unknown or expired code. */
  describe(codeInput: string): { deviceName: string; userAgent: string; ip: string; minutesAgo: number } | null {
    const session = this.byCode(codeInput)
    return session ? { deviceName: session.deviceName, userAgent: session.userAgent, ip: session.ip, minutesAgo: Math.max(0, Math.round((this.now() - (session.expiresAt - SESSION_SECONDS * 1000)) / 60_000)) } : null
  }

  /** A signed-in person's answer. Signing in is the proof, so there is nothing to guess and nothing to throttle. */
  approve(codeInput: string, approve: boolean, userId: string): { ok: true; deviceName: string } | { ok: false; reason: 'unknown' } {
    const session = this.byCode(codeInput)
    if (!session) return { ok: false, reason: 'unknown' }
    if (!approve) { session.status = 'denied'; return { ok: true, deviceName: session.deviceName } }
    this.grant(session, userId)
    return { ok: true, deviceName: session.deviceName }
  }

  private grant(session: Session, userId: string) {
    const { device, token } = this.devices.create(session.deviceName, session.userAgent, userId)
    session.status = 'approved'
    session.token = token
    session.deviceId = device.id
  }

  /** The legacy owner's answer. Approving needs the passphrase and is throttled per address. */
  decide(codeInput: string, approve: boolean, passphrase: string, ip: string): { ok: true; deviceName: string } | { ok: false; reason: 'unknown' | 'wrong-passphrase' | 'blocked' } {
    const session = this.byCode(codeInput)
    if (!session) return { ok: false, reason: 'unknown' }
    if (!approve) { session.status = 'denied'; return { ok: true, deviceName: session.deviceName } }
    if (this.throttle.blocked(ip)) return { ok: false, reason: 'blocked' }
    if (!this.passphrase || !same(passphrase, this.passphrase)) { this.throttle.failed(ip); return { ok: false, reason: 'wrong-passphrase' } }
    this.grant(session, OWNER_ID)
    return { ok: true, deviceName: session.deviceName }
  }

  /** A connected app asks for a code to show on its screen (or as a QR) for a new device. Valid for two minutes, once. */
  offer(userId: string): PairOffer {
    this.sweep()
    if ([...this.offers.values()].filter(offer => offer.userId === userId && !offer.claimed).length >= MAX_OFFERS_PER_USER) throw new PairingError(429, 'Too many codes are already showing. Use one, or wait a couple of minutes.')
    const offer: Offer = { id: randomUUID(), code: this.newCode(candidate => [...this.offers.values()].some(other => other.code === candidate)), userId, expiresAt: this.now() + OFFER_SECONDS * 1000, claimed: false }
    this.offers.set(offer.id, offer)
    return { offerId: offer.id, userCode: formatCode(offer.code), expiresIn: OFFER_SECONDS }
  }

  /** Lets the app that showed the code find out that it was used. Only the user who made the offer can ask. */
  offerStatus(offerId: string, userId: string): OfferStatus {
    this.sweep()
    const offer = this.offers.get(offerId)
    return offer && offer.userId === userId ? (offer.claimed ? 'claimed' : 'pending') : 'expired'
  }

  /** The new device typed a code. The right one yields a token for the offering user; wrong ones are counted against the address. */
  claim(codeInput: string, deviceName: string, userAgent: string, ip: string): { token: string; deviceId: string } {
    this.sweep()
    if (this.claimThrottle.blocked(ip)) throw new PairingError(429, 'Too many wrong codes. Wait ten minutes and try again.')
    const code = normalizeCode(codeInput)
    let match: Offer | undefined
    // Compare against every live offer in constant time, so how long it takes says nothing about how close a guess was.
    for (const offer of this.offers.values()) if (code.length === 8 && same(offer.code, code) && !offer.claimed) match = offer
    if (!match || !this.isActive(match.userId)) { this.claimThrottle.failed(ip); throw new PairingError(400, 'That code is not valid, or it has expired. Ask the other device for a new one.') }
    match.claimed = true // once, even if creating the device fails below
    const { device, token } = this.devices.create(cleanName(deviceName), userAgent, match.userId)
    return { token, deviceId: device.id }
  }

  page(codeInput: string, message = '', done: '' | 'approved' | 'denied' = '', signedInAs = ''): string {
    const info = this.describe(codeInput)
    const style = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b0b0b;color:#eee;font:14px/1.6 "Red Hat Display","Inter",system-ui,sans-serif}
main{width:min(100%,460px);padding:32px;border:1px solid #262626;border-radius:20px;background:#121212}p.eyebrow{margin:0 0 14px;color:#888;font-size:11px;letter-spacing:.15em;text-transform:uppercase}
h1{margin:0 0 12px;font-size:28px;font-weight:450;letter-spacing:-.05em}p{color:#b5b5b5}strong{color:#eee;font-weight:550}label{display:block;margin-top:22px;color:#b5b5b5;font-size:12px}
input{display:block;width:100%;margin-top:8px;padding:12px;border:1px solid #3a3a3a;border-radius:10px;color:#eee;background:#0b0b0b;font:inherit}input.code{font-size:22px;letter-spacing:.2em;text-align:center;text-transform:uppercase}input:focus-visible,button:focus-visible{outline:2px solid #d5bea7;outline-offset:2px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:12px;border:0;border-radius:10px;font:inherit;font-size:13px;font-weight:650;cursor:pointer}.go{color:#0b0b0b;background:#eee}.no{color:#b5b5b5;background:#262626}.msg{margin:16px 0 0;color:#e4a6a6}.who{margin:18px 0 0;padding:14px;border-radius:12px;background:#0b0b0b;color:#b5b5b5;font-size:13px}`
    const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Connect a device · voicebrain</title><style>${style}</style></head><body><main><p class="eyebrow">voicebrain</p>`
    if (done) return `${head}<h1>${done === 'approved' ? 'Device connected' : 'Request denied'}</h1><p>${done === 'approved' ? 'Go back to the app. It connects on its own, no need to copy anything.' : 'Nothing was connected.'}</p></main></body></html>`
    const detail = info
      ? `<div class="who"><strong>${escapeHtml(info.deviceName)}</strong> asked to connect ${info.minutesAgo < 1 ? 'a moment ago' : `${info.minutesAgo} min ago`}.<br>From ${escapeHtml(info.ip)}<br>${escapeHtml(info.userAgent.slice(0, 90))}</div>`
      : codeInput ? '<p class="msg" role="alert">That code is not valid, or it has expired. Start again in the app.</p>' : ''
    return `${head}<h1>Connect a device</h1><p>Approve this only if <strong>you</strong> just tapped “Connect” in your own voicebrain app and the code below is the one it shows.</p>${message ? `<p class="msg" role="alert">${escapeHtml(message)}</p>` : ''}${detail}
<form method="post" action="/pair/decision"><label>Code shown in the app<input class="code" name="code" value="${escapeHtml(info ? formatCode(normalizeCode(codeInput)) : codeInput.slice(0, 12))}" autocomplete="off" autocapitalize="characters" spellcheck="false" ${info ? '' : 'autofocus'}></label>
${signedInAs ? `<p class="who">Signed in as <strong>${escapeHtml(signedInAs)}</strong></p>` : `<label>Owner passphrase<input name="passphrase" type="password" autocomplete="current-password" ${info ? 'autofocus' : ''}></label>`}
<div class="row"><button class="no" name="decision" value="deny" type="submit" formnovalidate>Deny</button><button class="go" name="decision" value="approve" type="submit">Approve</button></div></form></main></body></html>`
  }
}
