import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Vault } from '../src/vault.ts'
import { tempDir } from './helpers.ts'

const exec = promisify(execFile)
let dir: Awaited<ReturnType<typeof tempDir>>
let root = ''
const git = async (...args: string[]) => (await exec('git', args, { cwd: root })).stdout
const ignored = (path: string) => exec('git', ['check-ignore', '-q', path], { cwd: root }).then(() => true, () => false)

beforeEach(async () => { dir = await tempDir(); root = join(dir.dir, 'vault') })
afterEach(() => dir.clean())

describe('what the vault keeps in git', () => {
  it('ignores generated pages but not the assistant\'s pages, even in a folder that shares a name', async () => {
    const vault = new Vault(root, true)
    await vault.init()
    for (const path of ['notes/2026/10/a.md', 'daily/2026-10-30.md', 'projects/trapper.md', 'people/nimal.md', 'tasks.md']) expect(await ignored(path), path).toBe(true)
    // Hand-written wiki pages in folders named like the generated ones must still be versioned.
    for (const path of ['wiki/projects/trapper.md', 'wiki/people/nimal.md', 'wiki/notes/ideas.md', 'wiki/daily/review.md', 'wiki/index.md', 'state/task-status.json', 'schema/AGENTS.md']) expect(await ignored(path), path).toBe(false)
    expect((await readFile(join(root, '.gitignore'), 'utf8')).split('\n')).toEqual(expect.arrayContaining(['/notes/', '/daily/', '/projects/', '/people/', '/tasks.md']))
  })

  it('commits a wiki page that lives under wiki/projects/', async () => {
    const vault = new Vault(root, true)
    await vault.init()
    await vault.write('wiki/projects/trapper.md', '# Trapper\n')
    await vault.write('projects/trapper.md', '# generated\n')
    await vault.commit('wiki: replace wiki/projects/trapper.md')
    expect((await git('ls-files')).split('\n')).toContain('wiki/projects/trapper.md')
    expect((await git('ls-files')).split('\n')).not.toContain('projects/trapper.md')
    expect(await git('log', '--format=%s')).toContain('wiki: replace wiki/projects/trapper.md')
  })

  it('stops tracking generated files in a vault made by an earlier version, and keeps them on disk', async () => {
    await mkdir(join(root, 'notes', '2026'), { recursive: true })
    await mkdir(join(root, 'daily'), { recursive: true })
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root })
    await writeFile(join(root, 'notes', '2026', 'old.md'), 'a transcript that should not stay in history\n')
    await writeFile(join(root, 'daily', 'old.md'), 'a day\n')
    await writeFile(join(root, 'tasks.md'), 'tasks\n')
    await exec('git', ['add', '-A'], { cwd: root })
    await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'old layout'], { cwd: root })
    expect((await git('ls-files')).split('\n')).toContain('notes/2026/old.md')

    const vault = new Vault(root, true)
    await vault.init()
    const tracked = (await git('ls-files')).split('\n')
    expect(tracked).not.toContain('notes/2026/old.md')
    expect(tracked).not.toContain('daily/old.md')
    expect(tracked).not.toContain('tasks.md')
    expect(existsSync(join(root, 'notes', '2026', 'old.md'))).toBe(true) // the files themselves stay
    expect(await git('log', '--format=%s')).toContain('Stop versioning generated files')
  })

  it('does nothing the second time', async () => {
    const vault = new Vault(root, true)
    await vault.init()
    const before = await git('rev-list', '--count', 'HEAD')
    await new Vault(root, true).init()
    expect(await git('rev-list', '--count', 'HEAD')).toBe(before)
  })

  it('works without git at all', async () => {
    const vault = new Vault(root, false)
    await vault.init()
    expect(existsSync(join(root, '.git'))).toBe(false)
    await vault.write('wiki/x.md', 'x')
    await vault.commit('nothing happens')
  })
})
