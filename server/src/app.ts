import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import express, { type NextFunction, type Request, type Response } from 'express'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Brain } from './brain.ts'
import type { Config } from './config.ts'
import { handleIngest } from './ingest.ts'
import { createMcpServer } from './mcp.ts'
import { OwnerOAuthProvider, staticTokenVerifier } from './oauth.ts'
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

  const app = express()
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next() })

  app.get('/health', (_req, res) => { res.json({ ok: true }) })

  // ---- the recorder app: upload, status ----
  const cors = (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', config.allowedOrigin)
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
    if (req.method === 'OPTIONS') { res.status(204).end(); return }
    next()
  }
  const ingestAuth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? ''
    if (config.insecure || (config.ingestToken && same(header.startsWith('Bearer ') ? header.slice(7) : '', config.ingestToken))) { next(); return }
    res.setHeader('WWW-Authenticate', 'Bearer')
    res.status(401).json({ error: 'unauthorized' })
  }
  app.use('/v1', cors, ingestAuth)
  app.get('/v1/ping', (_req, res) => { res.json({ ok: true }) })
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
      brain.close()
    },
  }
}

export { errorText }
