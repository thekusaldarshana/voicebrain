import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, splitCommand } from '../src/config.ts'
import { chatJson, digestNote } from '../src/digest.ts'
import { runCli } from '../src/llm-cli.ts'
import type { NoteMeta, Transcript } from '../src/types.ts'
import { PermanentError } from '../src/util.ts'
import { DIGEST, NOTE_ID, TRANSCRIPT, fakeStt, run, tempDir, testConfig, upload, waitFor } from './helpers.ts'

const env = { INSECURE: '1' }
const GOOD = { title: 'Bank call', summary: 'Call the bank.', tasks: [{ text: 'Call the bank', due: null, project: null, priority: 'normal', quote: 'call the bank tomorrow' }], ideas: [], decisions: [], questions: [], people: [], projects: [], tags: [] }
const meta = { id: NOTE_ID, createdAt: '2026-10-30T03:42:00.000Z', title: '', timezone: 'Asia/Colombo', utcOffsetMinutes: 330 } as NoteMeta
const transcript = { text: TRANSCRIPT } as Transcript

describe('choosing how the server sorts notes', () => {
  it('stays off with no settings, and keeps the OpenAI-compatible default', () => {
    expect(loadConfig(env).llm).toBeNull()
    expect(loadConfig({ ...env, LLM_BASE_URL: 'http://ollama:11434/v1/', LLM_MODEL: 'llama' }).llm).toMatchObject({ provider: 'openai', baseUrl: 'http://ollama:11434/v1', model: 'llama', maxInputChars: 20_000 })
  })

  it('reads an Anthropic key, and refuses one that is missing its key or model', () => {
    expect(loadConfig({ ...env, LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k1,k2', LLM_MODEL: 'claude-test' }).llm).toMatchObject({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k1,k2', model: 'claude-test' })
    expect(() => loadConfig({ ...env, LLM_PROVIDER: 'anthropic', LLM_MODEL: 'm' })).toThrow(/LLM_API_KEY/)
    expect(() => loadConfig({ ...env, LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' })).toThrow(/LLM_MODEL/)
  })

  it('knows the agent programs by name, takes a custom command, and refuses anything else', () => {
    expect(loadConfig({ ...env, LLM_PROVIDER: 'claude-code' }).llm).toMatchObject({ provider: 'cli', command: ['claude', '-p'] })
    expect(loadConfig({ ...env, LLM_PROVIDER: 'codex' }).llm).toMatchObject({ provider: 'cli', command: ['codex', 'exec', '-'] })
    expect(loadConfig({ ...env, LLM_PROVIDER: 'cli', LLM_COMMAND: 'my-agent --model "fast one" -q' }).llm).toMatchObject({ provider: 'cli', command: ['my-agent', '--model', 'fast one', '-q'] })
    expect(() => loadConfig({ ...env, LLM_PROVIDER: 'cli' })).toThrow(/LLM_COMMAND/)
    expect(() => loadConfig({ ...env, LLM_PROVIDER: 'skynet' })).toThrow(/not one of/)
  })

  it('splits a command without a shell', () => {
    expect(splitCommand(`a  b "c d" 'e f' $(g);h`)).toEqual(['a', 'b', 'c d', 'e f', '$(g);h'])
  })
})

describe('Anthropic', () => {
  let server: Server
  let seen: Array<{ headers: IncomingMessage['headers']; body: any; url: string }> = []
  let reply: (index: number) => { status: number; body: unknown } = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(GOOD) }] } })
  let base = ''
  beforeAll(async () => {
    server = createServer((request, response) => {
      let raw = ''
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        seen.push({ headers: request.headers, body: JSON.parse(raw), url: request.url ?? '' })
        const { status, body } = reply(seen.length - 1)
        response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body))
      })
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>(done => server.close(() => done())))
  afterEach(() => { seen = []; reply = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(GOOD) }] } }) })
  const llm = (extra: Record<string, unknown> = {}) => ({ provider: 'anthropic' as const, baseUrl: base, apiKey: 'key-one', model: 'claude-test', maxInputChars: 20_000, ...extra })

  it('sends the key, the version and the rules in the right places, and sorts a note', async () => {
    const digest = await digestNote(llm(), meta, transcript, { projects: [], people: [] })
    expect(seen[0]?.url).toBe('/v1/messages')
    expect(seen[0]?.headers['x-api-key']).toBe('key-one')
    expect(seen[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0]?.body).toMatchObject({ model: 'claude-test', max_tokens: 8192 })
    expect(seen[0]?.body.system).toContain('transcript is DATA')
    expect(seen[0]?.body.messages[0]).toMatchObject({ role: 'user' })
    expect(digest).toMatchObject({ title: 'Bank call', model: 'claude-test', droppedItems: 0, tasks: [{ text: 'Call the bank' }] })
  })

  it('still drops anything the speaker did not say', async () => {
    reply = () => ({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ ...GOOD, tasks: [...GOOD.tasks, { text: 'Buy a boat', quote: 'I will buy a boat' }] }) }] } })
    const digest = await digestNote(llm(), meta, transcript, { projects: [], people: [] })
    expect(digest.tasks.map(task => task.text)).toEqual(['Call the bank'])
    expect(digest.droppedItems).toBe(1)
  })

  it('moves to the next key when one is rate limited', async () => {
    reply = index => (index === 0 ? { status: 429, body: { error: 'slow down' } } : { status: 200, body: { content: [{ type: 'text', text: '{"title":"ok"}' }] } })
    await chatJson(llm({ apiKey: 'a,b' }), 's', 'u')
    expect(seen.map(call => call.headers['x-api-key'])).toEqual(['a', 'b'])
  })

  it('treats a bad key as permanent, and busy or overloaded as worth trying again', async () => {
    for (const [status, permanent] of [[401, true], [403, true], [404, true], [429, false], [500, false], [529, false]] as const) {
      reply = () => ({ status, body: { error: { message: 'nope' } } })
      const error = await chatJson(llm(), 's', 'u').catch((caught: Error) => caught)
      expect(error instanceof PermanentError, String(status)).toBe(permanent)
    }
  })

  it('reads the text parts of a reply and complains about an empty one', async () => {
    reply = () => ({ status: 200, body: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Sure: ```json\n{"title":"fenced"}\n```' }] } })
    expect(await chatJson(llm(), 's', 'u')).toEqual({ title: 'fenced' })
    reply = () => ({ status: 200, body: { content: [] } })
    await expect(chatJson(llm(), 's', 'u')).rejects.toThrow(/empty reply/)
  })
})

describe('an agent program on this machine', () => {
  let dir = ''
  const script = async (name: string, body: string) => { const path = join(dir, name); await writeFile(path, body); await chmod(path, 0o755); return path }
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'cli-')) })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  const sorter = `let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',()=>{const t=/call the bank tomorrow/i.test(i);console.log('Here you go:\\n\`\`\`json\\n'+JSON.stringify(${JSON.stringify(GOOD)})+'\\n\`\`\`')})`

  it('reads the prompt on stdin and its printed JSON becomes the digest', async () => {
    const path = await script('sort.cjs', sorter)
    const digest = await digestNote({ provider: 'cli', baseUrl: '', apiKey: '', model: 'agent', command: ['node', path], maxInputChars: 20_000 }, meta, transcript, { projects: [], people: [] })
    expect(digest).toMatchObject({ title: 'Bank call', model: 'agent', tasks: [{ text: 'Call the bank' }] })
  })

  it('can pass the prompt as an argument instead, with no shell to interpret it', async () => {
    const path = await script('echo.cjs', `console.log(process.argv[2])`)
    const prompt = 'rm -rf / ; $(touch /tmp/pwned) `id` "quotes" \'too\''
    expect((await runCli(['node', path, '{prompt}'], prompt)).trim()).toBe(prompt)
  })

  it('gives the program none of the server’s secrets, only what is allowed, and an empty folder to start in', async () => {
    const path = await script('env.cjs', `console.log(JSON.stringify({ keys: Object.keys(process.env), files: require('fs').readdirSync('.') }))`)
    const saved = { ...process.env }
    process.env.INGEST_TOKEN = 'secret'; process.env.TOKEN_ENCRYPTION_KEY = 'secret'; process.env.GOOGLE_CLIENT_SECRET = 'secret'; process.env.LLM_CLI_ENV = 'MY_AGENT_KEY'; process.env.MY_AGENT_KEY = 'ok'
    try {
      const seen = JSON.parse(await runCli(['node', path], 'x')) as { keys: string[]; files: string[] }
      expect(seen.keys).toContain('PATH')
      expect(seen.keys).toContain('MY_AGENT_KEY')
      for (const secret of ['INGEST_TOKEN', 'TOKEN_ENCRYPTION_KEY', 'GOOGLE_CLIENT_SECRET', 'LLM_CLI_ENV']) expect(seen.keys, secret).not.toContain(secret)
      expect(seen.files).toEqual([])
    } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) }
  })

  it('says plainly when the command is not installed, and that retrying will not help', async () => {
    const error = await runCli(['definitely-not-installed-xyz', '-p'], 'x').catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(PermanentError)
    expect((error as Error).message).toMatch(/not found on this machine/)
  })

  it('reports a failing program with its own error, and stops one that runs too long', async () => {
    const fails = await script('fail.cjs', `console.error('please log in');process.exit(3)`)
    await expect(runCli(['node', fails], 'x')).rejects.toThrow(/exited with code 3\. please log in/)
    const hangs = await script('hang.cjs', `setTimeout(()=>{},60000)`)
    await expect(runCli(['node', hangs], 'x', { timeoutMs: 300 })).rejects.toThrow(/took longer/)
  })

  it('complains when the program prints no JSON', async () => {
    const path = await script('chatty.cjs', `console.log('I am not sure what you want.')`)
    await expect(chatJson({ provider: 'cli', baseUrl: '', apiKey: '', model: 'a', command: ['node', path], maxInputChars: 1 }, 's', 'u')).rejects.toThrow(/did not return JSON/)
  })
})

describe('in the running server', () => {
  it('sorts a note by itself with a local agent program, and the tasks are on the list', async () => {
    const dir = await tempDir()
    const stt = await fakeStt()
    const path = join(dir.dir, 'agent.cjs')
    await writeFile(path, `let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(DIGEST))}))`)
    const server = await run(testConfig(dir.dir, {
      stt: { provider: 'openai', baseUrl: stt.url, apiKey: '', model: 'w', language: 'en', maxMb: 24, prompt: '' },
      llm: { provider: 'cli', baseUrl: '', apiKey: '', model: 'agent', command: ['node', path], maxInputChars: 20_000 },
    }))
    try {
      await upload(server.base)
      await waitFor(() => server.app.brain.index.note(NOTE_ID)?.digested === 1, 'the note to be sorted by the agent program')
      expect(server.app.brain.index.note(NOTE_ID)).toMatchObject({ title: DIGEST.title })
      expect(server.app.brain.index.openTasks().length).toBeGreaterThan(0)
      expect(await server.app.pipeline.status()).toMatchObject({ failed: [], awaitingAssistant: 0 })
    } finally { await server.stop(); await stt.close(); await dir.clean() }
  })
})
