import { adoptOwner } from './adopt.ts'
import { createApp } from './app.ts'
import { Brain } from './brain.ts'
import { authMode, loadConfig } from './config.ts'

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

/** Throws away nothing that matters: rebuilds the search index and the generated vault pages from the stored notes. */
async function reindex() {
  const brain = new Brain(loadConfig())
  try {
    await brain.vault.init()
    const { notes, pages } = await brain.reindex()
    console.log(`reindexed ${notes} note${notes === 1 ? '' : 's'}, wrote ${pages} vault page${pages === 1 ? '' : 's'}`)
  } finally { brain.close() }
}

/** Gives the owner identity's notes, vault, devices and assistant connections to one Google account. */
function adopt(argv: string[]) {
  const email = argv.find(arg => !arg.startsWith('--')) ?? ''
  if (!email) { console.error('Usage: node src/main.ts adopt-owner <google email> [--apply]   (stop the server first; without --apply it only reports)'); process.exit(2) }
  const result = adoptOwner(loadConfig().dataDir, email, argv.includes('--apply'))
  const what = `${result.notes} note${result.notes === 1 ? '' : 's'}, ${result.devices} device${result.devices === 1 ? '' : 's'}, ${result.assistantTokens} assistant connection${result.assistantTokens === 1 ? '' : 's'}`
  console.log(result.applied ? `moved ${what} to ${result.email}` : `would move ${what} to ${result.email}. Run again with --apply (server stopped) to do it.`)
}

async function main() {
  if (process.argv[2] === 'pair') return pair(process.argv.slice(3))
  if (process.argv[2] === 'reindex') return reindex()
  if (process.argv[2] === 'adopt-owner') return adopt(process.argv.slice(3))
  const config = loadConfig()
  const app = createApp(config)
  await app.start()
  const port = await app.listen()
  const on = (label: string, enabled: boolean, hint: string) => console.log(`  ${enabled ? 'on ' : 'OFF'}  ${label}${enabled ? '' : `  (${hint})`}`)
  console.log(`voicebrain listening on :${port}, data in ${config.dataDir}`)
  on('upload from the recorder app', true, '')
  on('transcription', config.stt !== null, 'set STT_BASE_URL')
  console.log(config.llm ? '  on   sorting notes with your own model server (LLM_BASE_URL); ChatGPT can sort too' : '  on   sorting notes by ChatGPT, through the MCP tools (no model or API key on this server)')
  const mode = authMode(config)
  on('sign-in with Google', mode === 'google', 'set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL')
  if (mode === 'google') console.log(config.allowedEmails.length ? `        only ${config.allowedEmails.length} allowed email address${config.allowedEmails.length === 1 ? '' : 'es'} can sign in` : '        no ALLOWED_EMAILS: the first person to sign in claims this server')
  if (mode === 'google' && config.ownerPassphrase) console.log('        OWNER_PASSPHRASE is ignored while Google sign-in is on')
  on('assistant over MCP (OAuth)', mode !== 'none', 'set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL')
  if (mode === 'passphrase') console.log('        legacy: approving with OWNER_PASSPHRASE. Set up Google sign-in to drop it')
  on('Google Drive per person', config.driveEnabled, 'set DRIVE_ENABLED=1 and TOKEN_ENCRYPTION_KEY')
  on('assistant over MCP (static token)', Boolean(config.mcpToken), 'set MCP_TOKEN')
  const stop = async () => { await app.close(); process.exit(0) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
