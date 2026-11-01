import express, { Router, type Request, type Response } from 'express'
import type { AgentKeys } from './agent-keys.ts'
import type { DriveAccounts } from './drive.ts'
import { GoogleAuth, SignInError } from './google.ts'
import type { User, Users } from './users.ts'

export const SESSION_COOKIE = 'vb_session'
const LOGIN_COOKIE = 'vb_login'
const DRIVE_COOKIE = 'vb_drive'

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 1) continue
    const name = part.slice(0, at).trim()
    if (!(name in out)) out[name] = part.slice(at + 1).trim()
  }
  return out
}

/** A page to return to after signing in must be a path on this server. Anything else is dropped, so the sign-in cannot be used to bounce people to another site. */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || /[\\\u0000-\u001f]/.test(next) || next.length > 600) return '/'
  return next
}

const STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b0b0b;color:#eee;font:14px/1.6 "Red Hat Display","Inter",system-ui,sans-serif}
main{width:min(100%,460px);padding:32px;border:1px solid #262626;border-radius:20px;background:#121212}p.eyebrow{margin:0 0 14px;color:#888;font-size:11px;letter-spacing:.15em;text-transform:uppercase}
h1{margin:0 0 12px;font-size:28px;font-weight:450;letter-spacing:-.05em}p{color:#b5b5b5}a{color:#d5bea7}`

export function messagePage(title: string, message: string, link?: { href: string; text: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · voicebrain</title><style>${STYLE}</style></head>
<body><main><p class="eyebrow">voicebrain</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>` : ''}</main></body></html>`
}

export interface AuthKit {
  router: Router
  /** The signed-in, still-allowed person behind this request's cookie, or null. */
  userOf(req: Request): User | null
  /** Where to send a browser so the person signs in, and comes back to `next`. */
  signInUrl(next: string): string
  /** True unless the browser says the request was started by another site. Cookies are SameSite=Lax too; this is the second lock. */
  originOk(req: Request): boolean
}

/**
 * Google sign-in for the pages on this server: /auth/google/start, /auth/google/callback and /auth/logout.
 * The browser keeps one HttpOnly session cookie (a random value; only its hash is stored).
 */
export function createAuth(options: { users: Users; google: GoogleAuth; publicUrl: string; drive?: DriveAccounts | null; agentKeys?: AgentKeys | null }): AuthKit {
  const { users, google, publicUrl, drive, agentKeys } = options
  const origin = new URL(publicUrl).origin
  const secure = publicUrl.startsWith('https://')
  const cookie = (name: string, value: string, maxAgeSeconds: number, path = '/') =>
    `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`

  const userOf = (req: Request) => users.userForSession(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '')
  const signInUrl = (next: string) => `/auth/google/start?next=${encodeURIComponent(safeNext(next))}`
  const originOk = (req: Request) => { const sent = req.headers.origin; return sent === undefined || sent === origin }
  const page = (res: Response, status: number, title: string, message: string, link?: { href: string; text: string }) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    res.status(status).type('html').send(messagePage(title, message, link))
  }

  const router = Router()

  router.get('/auth/google/start', (req, res) => {
    try {
      const { url, state } = google.begin(safeNext(req.query.next))
      // The browser that starts a sign-in must be the one that finishes it, or someone could sign a victim in as themselves.
      res.append('Set-Cookie', cookie(LOGIN_COOKIE, state, 600, '/auth/google'))
      res.setHeader('Cache-Control', 'no-store')
      res.redirect(302, url)
    } catch (error) {
      if (error instanceof SignInError) { page(res, error.status, 'Sign-in unavailable', error.message); return }
      throw error
    }
  })

  router.get('/auth/google/callback', async (req, res, next) => {
    try {
      const { profile, next: back } = await google.finish({ code: req.query.code, state: req.query.state, error: req.query.error }, parseCookies(req.headers.cookie)[LOGIN_COOKIE] ?? '')
      res.append('Set-Cookie', cookie(LOGIN_COOKIE, '', 0, '/auth/google'))
      const result = users.signIn(profile)
      if (!result.ok) {
        console.error(`sign-in refused: ${result.reason}`)
        page(res, 403, 'Not allowed', result.reason === 'instance-claimed' ? 'This voicebrain already belongs to someone else.' : 'This Google account is not on the list for this voicebrain.')
        return
      }
      if (result.claimed) console.log('voicebrain claimed by its first sign-in')
      const session = users.createSession(result.user.id)
      res.append('Set-Cookie', cookie(SESSION_COOKIE, session.token, Math.floor((session.expiresAt - Date.now()) / 1000)))
      res.setHeader('Cache-Control', 'no-store')
      res.redirect(302, back)
    } catch (error) {
      if (error instanceof SignInError) { page(res, error.status, 'Sign-in failed', error.message, { href: '/auth/google/start', text: 'Try again' }); return }
      next(error)
    }
  })

  // Connecting Drive: a second consent, only for someone who is already signed in, bound to this browser like sign-in is.
  if (drive) {
    router.get('/auth/drive/start', (req, res) => {
      const user = userOf(req)
      if (!user) { res.redirect(302, signInUrl('/auth/drive/start')); return }
      try {
        const { url, state } = google.beginDrive(user.id, user.email)
        res.append('Set-Cookie', cookie(DRIVE_COOKIE, state, 600, '/auth/drive'))
        res.setHeader('Cache-Control', 'no-store')
        res.redirect(302, url)
      } catch (error) {
        if (error instanceof SignInError) { page(res, error.status, 'Drive unavailable', error.message); return }
        throw error
      }
    })

    router.get('/auth/drive/callback', async (req, res, next) => {
      const user = userOf(req)
      if (!user) { page(res, 401, 'Sign in first', 'Sign in with Google, then connect Drive again.', { href: signInUrl('/auth/drive/start'), text: 'Sign in' }); return }
      try {
        const grant = await google.finishDrive({ code: req.query.code, state: req.query.state, error: req.query.error }, parseCookies(req.headers.cookie)[DRIVE_COOKIE] ?? '', user.id)
        res.append('Set-Cookie', cookie(DRIVE_COOKIE, '', 0, '/auth/drive'))
        drive.save(user.id, grant)
        page(res, 200, 'Drive connected', 'voicebrain can now keep your notes in your own Google Drive. Go back to the app.')
      } catch (error) {
        if (error instanceof SignInError) { res.append('Set-Cookie', cookie(DRIVE_COOKIE, '', 0, '/auth/drive')); page(res, error.status, 'Drive not connected', error.message, { href: '/auth/drive/start', text: 'Try again' }); return }
        next(error)
      }
    })
  }

  // The page a person opens to see who they are signed in as, and to sign out or manage their Drive. Plain HTML, no scripts.
  /** Ready-to-paste settings for the coding agents, with the key filled in. Shown once, when the key is made. */
  const agentSnippets = (secret: string) => {
    const url = `${publicUrl}/mcp`
    return [
      `Claude Code:\nclaude mcp add --transport http voicebrain ${url} --header "Authorization: Bearer ${secret}"`,
      `opencode (opencode.json):\n{ "mcp": { "voicebrain": { "type": "remote", "url": "${url}", "oauth": false, "headers": { "Authorization": "Bearer ${secret}" } } } }`,
      `Cursor (~/.cursor/mcp.json):\n{ "mcpServers": { "voicebrain": { "url": "${url}", "headers": { "Authorization": "Bearer ${secret}" } } } }`,
      `Codex (~/.codex/config.toml), with the key in the VOICEBRAIN_KEY environment variable:\n[mcp_servers.voicebrain]\nurl = "${url}"\nbearer_token_env_var = "VOICEBRAIN_KEY"`,
    ].join('\n\n')
  }
  const keysBlock = (user: User, secret = '') => {
    if (!agentKeys) return ''
    const keys = agentKeys.list(user.id)
    const rows = keys.map(key => `<li><span>${escapeHtml(key.name)} <small>made ${escapeHtml(key.createdAt.slice(0, 10))}, ${key.lastUsedAt ? `last used ${escapeHtml(key.lastUsedAt.slice(0, 10))}` : 'never used'}</small></span><form method="post" action="/account/keys/revoke"><input type="hidden" name="id" value="${escapeHtml(key.id)}"><button class="quiet" type="submit">Revoke</button></form></li>`).join('')
    return `<h2>Coding agents</h2><p>Connect Claude Code, Cursor, opencode, Codex or any tool that speaks MCP to your notes with a personal key. A key shows once, can be revoked on its own, and gives the tool the same access to your notes that you have.</p>${secret ? `<p class="note" role="status">Your new key. Copy it now, it will not be shown again:</p><pre>${escapeHtml(agentSnippets(secret))}</pre>` : ''}${keys.length ? `<ul class="keys">${rows}</ul>` : ''}<form method="post" action="/account/keys" class="inline"><input name="name" maxlength="60" placeholder="Name, for example My laptop" aria-label="Name for the new key"><button type="submit">Create a key</button></form>`
  }
  const accountPage = (user: User, notice = '', secret = '') => {
    const connected = drive?.isConnected(user.id) ?? false
    const driveBlock = !drive ? '' : connected
      ? `<h2>Google Drive</h2><p>Connected. Your notes are kept in your own Drive.</p><form method="post" action="/account/drive/disconnect"><button class="quiet" type="submit">Disconnect Drive</button></form>`
      : `<h2>Google Drive</h2><p>Not connected yet. Connect it so your notes are kept in your own Drive.</p><p><a class="btn" href="/auth/drive/start">Connect Google Drive</a></p>`
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Your account · voicebrain</title><style>${STYLE}
h2{margin:24px 0 6px;font-size:15px;font-weight:600;letter-spacing:0;color:#eee}.btn,button{display:inline-block;padding:10px 16px;border-radius:999px;border:1px solid #3a3a3a;background:#d5bea7;color:#111;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}button.quiet{background:none;color:#eee}.note{color:#d5bea7}pre{white-space:pre-wrap;word-break:break-all;background:#0b0b0b;border:1px solid #262626;border-radius:12px;padding:12px;font-size:12px;color:#eee}ul.keys{list-style:none;padding:0;margin:12px 0}ul.keys li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-top:1px solid #262626}ul.keys small{display:block;color:#888}form.inline{display:flex;gap:8px;flex-wrap:wrap}form.inline input{flex:1;min-width:160px;padding:10px 12px;border-radius:10px;border:1px solid #3a3a3a;background:#0b0b0b;color:#eee;font:inherit}</style></head>
<body><main><p class="eyebrow">voicebrain</p><h1>Your account</h1>${notice ? `<p class="note" role="status">${escapeHtml(notice)}</p>` : ''}<p>Signed in as <strong>${escapeHtml(user.email)}</strong>.</p>${driveBlock}
${keysBlock(user, secret)}
<h2>Sign out</h2><p>This signs out this browser. Phones and computers you connected stay connected until you disconnect them in the app.</p><form method="post" action="/account/signout"><button class="quiet" type="submit">Sign out</button></form></main></body></html>`
  }
  const sendAccount = (res: Response, user: User, notice = '', secret = '') => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    res.status(200).type('html').send(accountPage(user, notice, secret))
  }
  router.get('/account', (req, res) => {
    const user = userOf(req)
    if (!user) { res.redirect(302, signInUrl('/account')); return }
    sendAccount(res, user)
  })
  router.post('/account/signout', (req, res) => {
    if (!originOk(req)) { page(res, 403, 'Not allowed', 'This request came from another site.'); return }
    users.endSession(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '')
    res.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0))
    page(res, 200, 'Signed out', 'You are signed out of voicebrain in this browser.', { href: '/account', text: 'Sign in again' })
  })
  router.post('/account/keys', express.urlencoded({ extended: false }), (req, res) => {
    if (!originOk(req)) { page(res, 403, 'Not allowed', 'This request came from another site.'); return }
    const user = userOf(req)
    if (!user || !agentKeys) { res.redirect(303, signInUrl('/account')); return }
    const made = agentKeys.create(user.id, typeof req.body?.name === 'string' ? req.body.name : '')
    if (!made) { sendAccount(res, user, 'You already have 20 keys. Revoke one you no longer use first.'); return }
    sendAccount(res, user, '', made.secret)
  })
  router.post('/account/keys/revoke', express.urlencoded({ extended: false }), (req, res) => {
    if (!originOk(req)) { page(res, 403, 'Not allowed', 'This request came from another site.'); return }
    const user = userOf(req)
    if (!user || !agentKeys) { res.redirect(303, signInUrl('/account')); return }
    const done = agentKeys.revoke(user.id, typeof req.body?.id === 'string' ? req.body.id : '')
    sendAccount(res, user, done ? 'Key revoked. Anything using it stops working now.' : 'That key was not found.')
  })
  router.post('/account/drive/disconnect', async (req, res, next) => {
    try {
      if (!originOk(req)) { page(res, 403, 'Not allowed', 'This request came from another site.'); return }
      const user = userOf(req)
      if (!user) { res.redirect(303, signInUrl('/account')); return }
      await drive?.disconnect(user.id)
      sendAccount(res, user, 'Google Drive is disconnected.')
    } catch (error) { next(error) }
  })

  router.post('/auth/logout', (req, res) => {
    if (!originOk(req)) { res.status(403).json({ error: 'This request came from another site.' }); return }
    users.endSession(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? '')
    res.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0))
    res.status(204).end()
  })

  return { router, userOf, signInUrl, originOk }
}
