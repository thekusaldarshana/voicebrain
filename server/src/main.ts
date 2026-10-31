import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

function pair(argv: string[]) {
  const get = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? (argv[at + 1] ?? '') : '' }
  const app = get('app')
  const endpoint = get('endpoint')
  const token = get('token') || process.env.INGEST_TOKEN || ''
  if (!app || !endpoint) { console.error('Usage: node src/main.ts pair --app <recorder app url> --endpoint <this server url> [--token <ingest token>] [--name <device name>]'); process.exit(2) }
  const params = new URLSearchParams({ e: endpoint })
  if (token) params.set('t', token)
  if (get('name')) params.set('n', get('name'))
  console.log(`${app.replace(/\/+$/, '')}/#/pair?${params}`)
}

async function main() {
  if (process.argv[2] === 'pair') return pair(process.argv.slice(3))
  const config = loadConfig()
  const app = createApp(config)
  await app.start()
  const port = await app.listen()
  const on = (label: string, enabled: boolean, hint: string) => console.log(`  ${enabled ? 'on ' : 'OFF'}  ${label}${enabled ? '' : `  (${hint})`}`)
  console.log(`voicebrain listening on :${port}, data in ${config.dataDir}`)
  on('upload from the recorder app', true, '')
  on('transcription', config.stt !== null, 'set STT_BASE_URL')
  on('task extraction', config.llm !== null, 'set LLM_BASE_URL and LLM_MODEL')
  on('assistant over MCP (OAuth)', Boolean(config.ownerPassphrase), 'set OWNER_PASSPHRASE and PUBLIC_URL')
  on('assistant over MCP (static token)', Boolean(config.mcpToken), 'set MCP_TOKEN')
  const stop = async () => { await app.close(); process.exit(0) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
