import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermanentError } from './util.ts'

const MAX_OUTPUT = 2 * 1024 * 1024
/** What the program is allowed to see of this server's environment. Never the tokens, keys or secrets the server holds. */
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']

/** The environment a program is started with: the safe names above, plus any named in LLM_CLI_ENV (for example ANTHROPIC_API_KEY). */
export function cliEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = [...SAFE_ENV, ...(source.LLM_CLI_ENV ?? '').split(',').map(name => name.trim()).filter(Boolean)]
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) if (source[name] !== undefined) env[name] = source[name]
  return env
}

/**
 * Runs an agent program (Claude Code, Codex, opencode, or anything that prints an answer) on one prompt and returns what it
 * printed. The text being sorted is a stranger's words, so the program gets none of this server's secrets, starts in a
 * fresh empty folder, and no shell ever sees the prompt: it goes in on stdin, or in place of a `{prompt}` argument.
 */
export async function runCli(command: string[], prompt: string, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const [program, ...rest] = command
  if (!program) throw new PermanentError('No command is set to sort notes with.')
  const viaArgument = rest.some(arg => arg.includes('{prompt}'))
  const args = rest.map(arg => arg.replaceAll('{prompt}', prompt))
  const cwd = await mkdtemp(join(tmpdir(), 'voicebrain-llm-'))
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(program, args, { cwd, env: options.env ?? cliEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let over = false
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${program} took longer than ${Math.round((options.timeoutMs ?? 300_000) / 1000)} seconds and was stopped.`)) }, options.timeoutMs ?? 300_000)
      child.stdout.on('data', chunk => { out += chunk; if (out.length > MAX_OUTPUT && !over) { over = true; child.kill('SIGKILL') } })
      child.stderr.on('data', chunk => { err = (err + chunk).slice(-2000) })
      child.on('error', error => {
        clearTimeout(timer)
        reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new PermanentError(`The command "${program}" was not found on this machine, so notes cannot be sorted with it. Install it (and sign in to it) where the server runs, or use another LLM_PROVIDER.`) : error)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (over) reject(new Error(`${program} printed more than ${MAX_OUTPUT} bytes.`))
        else if (code !== 0) reject(new Error(`${program} exited with code ${code}. ${err.trim().slice(-400)}`.trim()))
        else resolve(out)
      })
      child.stdin.on('error', () => undefined) // the program may exit without reading its input
      child.stdin.end(viaArgument ? '' : prompt)
    })
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
