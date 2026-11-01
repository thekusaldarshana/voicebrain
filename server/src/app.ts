import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import express, { type NextFunction, type Request, type Response } from 'express'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Brain } from './brain.ts'
import type { Config } from './config.ts'
import { Devices } from './devices.ts'
import { handleIngest } from './ingest.ts'
import { createMcpServer } from './mcp.ts'
import { OwnerOAuthProvider, staticTokenVerifier } from './oauth.ts'
import { Pairing, PairingError } from './pairing.ts'
import { Pipeline, type PipelineOptions } from './pipeline.ts'
import { UUID, errorText } from './util.ts'
import { join } from 'node:path'

const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

export interface App {
  express: express.Express
  brain: Brain
  pipeline: Pipeline
  /** Opens the files and database, then starts the worker. */
  start(): Promise<void>
  listen(port?: number): Promise<number>
  close(): Promise<void>
}

export function createApp(config: Config, options: PipelineOptions = {}): App {
  const brain = new Brain(config)
  const pipeline = new Pipeline(brain, options)
  brain.onNewWork = () => pipeline.kick()
  let provider: OwnerOAuthProvider | null = null
  let http: Server | null = null
  const devices = new Devices(join(config.dataDir, 'devices.sqlite'))
  // Pairing needs the owner passphrase (to approve) and a public address (to show the approval page).
  const pairing = config.ownerPassphrase && config.publicUrl ? new Pairing({ devices, passphrase: config.ownerPassphrase, publicUrl: config.publicUrl }) : null

  const app = express()
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next() })

  app.get('/health', (_req, res) => { res.json({ ok: true }) })

  // ---- the recorder app: pairing, upload, editing, status ----
  const cors = (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin)
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
    if (req.method === 'OPTIONS') { res.status(204).end(); return }
    next()
  }
  app.use('/v1', cors)

  // Adding a device: no token yet, so these two are open. The approval itself needs the owner passphrase.
  app.post('/v1/pair/start', express.json({ limit: '4kb' }), (req, res) => {
    if (!pairing) { res.status(501).json({ error: 'Pairing is not set up on this server (it needs OWNER_PASSPHRASE and PUBLIC_URL).' }); return }
    try {
      const body = (req.body ?? {}) as { deviceName?: unknown }
      res.json(pairing.start(typeof body.deviceName === 'string' ? body.deviceName : '', String(req.headers['user-agent'] ?? ''), req.ip ?? 'unknown'))
    } catch (error) {
      if (error instanceof PairingError) { res.status(error.status).json({ error: error.message }); return }
      throw error
    }
  })
  app.post('/v1/pair/poll', express.json({ limit: '4kb' }), (req, res) => {
    const body = (req.body ?? {}) as { pairId?: unknown; pollToken?: unknown }
    const result = pairing && typeof body.pairId === 'string' && typeof body.pollToken === 'string' ? pairing.poll(body.pairId, body.pollToken) : { status: 'expired' as const }
    res.json('token' in result ? { ...result, endpoint: config.publicUrl } : result)
  })

  const bearerOf = (req: Request) => { const header = req.headers.authorization ?? ''; return header.startsWith('Bearer ') ? header.slice(7) : '' }
  const ingestAuth = (req: Request, res: Response, next: NextFunction) => {
    const token = bearerOf(req)
    if (config.insecure || (config.ingestToken && same(token, config.ingestToken))) { res.locals.admin = true; next(); return }
    const device = token ? devices.verify(token) : null
    if (device) { res.locals.device = device; next(); return }
    res.setHeader('WWW-Authenticate', 'Bearer')
    res.status(401).json({ error: 'unauthorized' })
  }
  app.use('/v1', ingestAuth)
  app.get('/v1/ping', (_req, res) => { res.json({ ok: true }) })
  app.get('/v1/me', (_req, res) => { const device = res.locals.device as { id: string; name: string } | undefined; res.json({ device: device ? { id: device.id, name: device.name } : null, pairing: Boolean(pairing) }) })
  app.get('/v1/devices', (_req, res) => {
    const mine = (res.locals.device as { id: string } | undefined)?.id
    res.json({ devices: devices.list().map(device => ({ ...device, current: device.id === mine })) })
  })
  app.delete('/v1/devices/:id', (req, res) => {
    // A device can disconnect itself; the owner's own token can disconnect any device.
    const mine = (res.locals.device as { id: string } | undefined)?.id
    const id = String(req.params.id)
    if (!res.locals.admin && id !== mine) { res.status(403).json({ error: 'A device can only disconnect itself.' }); return }
    res.status(devices.revoke(id) ? 204 : 404).end()
  })
  app.get('/v1/status', async (_req, res) => { res.json(await pipeline.status()) })
  app.post('/v1/notes', async (req, res, next) => {
    try {
      const meta = await handleIngest(req, res, brain.store, config)
      if (meta) pipeline.kick()
    } catch (error) { next(error) }
  })
  app.post('/v1/notes/:id/retry', async (req, res) => {
    const id = String(req.params.id)
    res.status(UUID.test(id) && (await pipeline.retry(id)) ? 202 : 404).json({ ok: UUID.test(id) })
  })
  // Edits made in the app after upload. The user's own title always beats the one the model wrote.
  app.patch('/v1/notes/:id', express.json({ limit: '20kb' }), async (req, res, next) => {
    try {
      const id = String(req.params.id)
      const body = (req.body ?? {}) as { title?: unknown; tags?: unknown }
      const patch: { title?: string; tags?: string[] } = {}
      if (typeof body.title === 'string') patch.title = body.title
      if (Array.isArray(body.tags)) patch.tags = body.tags.filter((tag): tag is string => typeof tag === 'string')
      const done = UUID.test(id) ? await brain.editNote(id, patch, 'user') : null
      if (done) res.json({ ok: true, title: done.title }); else res.status(404).json({ error: 'No such note.' })
    } catch (error) { next(error) }
  })
  // Deleting is final: audio, transcript, digest, vault page, search entries and tasks.
  app.delete('/v1/notes/:id', async (req, res, next) => {
    try {
      const done = await brain.deleteNote(String(req.params.id))
      res.status(done ? 204 : 404).end()
    } catch (error) { next(error) }
  })

  // The page the owner opens to approve a new device.
  const securePage = (res: Response) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); res.type('html') }
  app.get('/pair', (req, res) => {
    if (!pairing) { res.status(404).type('text').send('Pairing is not set up on this server.'); return }
    securePage(res)
    res.send(pairing.page(typeof req.query.code === 'string' ? req.query.code : ''))
  })
  app.post('/pair/decision', express.urlencoded({ extended: false }), (req, res) => {
    if (!pairing) { res.status(404).type('text').send('Pairing is not set up on this server.'); return }
    const body = (req.body ?? {}) as Record<string, unknown>
    const code = typeof body.code === 'string' ? body.code : ''
    const approve = body.decision === 'approve'
    const result = pairing.decide(code, approve, typeof body.passphrase === 'string' ? body.passphrase : '', req.ip ?? 'unknown')
    securePage(res)
    if (result.ok) { res.send(pairing.page('', '', approve ? 'approved' : 'denied')); return }
    const message = result.reason === 'wrong-passphrase' ? 'That passphrase is not right.' : result.reason === 'blocked' ? 'Too many wrong attempts. Wait ten minutes and try again.' : ''
    res.status(result.reason === 'blocked' ? 429 : result.reason === 'wrong-passphrase' ? 401 : 400).send(pairing.page(code, message))
  })

  // ---- the assistant: MCP over HTTP, signed in with OAuth or a static token ----
  const mcpUrl = config.publicUrl ? `${config.publicUrl}/mcp` : ''
  if (config.ownerPassphrase || config.mcpToken) {
    const verifier = config.ownerPassphrase
      ? (provider = new OwnerOAuthProvider({ dbPath: join(config.dataDir, 'auth.sqlite'), passphrase: config.ownerPassphrase, staticToken: config.mcpToken }))
      : staticTokenVerifier(config.mcpToken)
    if (provider) {
      const issuerUrl = new URL(config.publicUrl)
      app.use(mcpAuthRouter({
        provider, issuerUrl, resourceServerUrl: new URL(mcpUrl), scopesSupported: ['mcp'], resourceName: 'voicebrain',
        // Registered clients never expire: this is one person's own server, and a connector that silently dies after 30 days is worse than no expiry.
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
      }))
      app.post('/authorize/decision', express.urlencoded({ extended: false }), (req, res, next) => { provider?.decide(req, res).catch(next) })
    }
    const resourceMetadataUrl = config.publicUrl ? `${config.publicUrl}/.well-known/oauth-protected-resource/mcp` : undefined
    const guard = requireBearerAuth({ verifier, ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), requiredScopes: ['mcp'] })
    app.post('/mcp', guard, express.json({ limit: '2mb' }), async (req, res) => {
      const server = createMcpServer(brain)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    })
    const notAllowed = (_req: Request, res: Response) => { res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }) }
    app.get('/mcp', guard, notAllowed)
    app.delete('/mcp', guard, notAllowed)
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((error as { type?: string })?.type === 'entity.parse.failed') { res.status(400).json({ error: 'The request body is not valid JSON.' }); return }
    console.error(error)
    if (!res.headersSent) res.status(500).json({ error: 'server error' })
  })

  return {
    express: app,
    brain,
    pipeline,
    async start() {
      await brain.init()
      if (config.workerEnabled) pipeline.start()
    },
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        http = app.listen(port, config.host, () => { const address = http?.address(); resolve(typeof address === 'object' && address ? address.port : port) })
        http.on('error', reject)
      })
    },
    async close() {
      await pipeline.stop()
      await new Promise<void>(done => { if (!http) { done(); return } http.closeAllConnections?.(); http.close(() => done()) })
      provider?.close()
      devices.close()
      brain.close()
    },
  }
}

export { errorText }
