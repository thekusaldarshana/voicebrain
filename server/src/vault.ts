import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { NoteRow, TaskRow } from './index.ts'
import type { Digest, NoteMeta, Segment, TaskStatus, Transcript } from './types.ts'
import { Mutex, errorText, formatClock, formatDuration, localParts, slugify, writeFileAtomic } from './util.ts'

const exec = promisify(execFile)
const yaml = (value: unknown) => JSON.stringify(value)

export const SCHEMA_DOC = `# How this vault works

This vault is written by **voicebrain** from voice notes, and read by an assistant over MCP.

## Layers
- \`notes/\` one file per voice note: summary, extracted items with the exact words they came from, marked moments, full transcript. **Generated. Do not edit**: it is rewritten when the note is re-processed.
- \`daily/\`, \`projects/\`, \`people/\`, \`tasks.md\` **Generated views.** Do not edit.
- \`wiki/\` **Yours and the assistant's.** Free-form pages that synthesize what the notes say. Nothing generated ever touches this folder.
- The raw audio and word-for-word transcripts live outside the vault in \`inbox/<id>/\`. They are the source of truth and are never changed.

## Rules for the assistant
1. Cite sources. Every claim in a wiki page links to the note it came from: \`[[notes/2026/10/2026-10-31-0912-ab12cd34]]\`.
2. Do not invent. If the notes do not say it, do not write it. Say "not mentioned".
3. Keep the speaker's own words for opinions, decisions and feelings; quote them.
4. When two notes disagree, keep both with their dates. Do not silently overwrite the earlier one.
5. Prefer updating an existing page over creating a near-duplicate. Keep \`wiki/index.md\` current: one line per page.
6. Open loops (tasks, questions) are tracked by the system. Mark tasks done with the task tool, not by editing text.
7. During a weekly review: read the week's notes, update project and person pages in \`wiki/\`, list contradictions and stale items at the top of \`wiki/review.md\`.
`

export const WIKI_INDEX = `# Wiki index

One line per page, newest first. Kept by the assistant. Add a page here whenever you create one.

`

const slug = (text: string) => slugify(text)
export const wikiLink = (path: string, label?: string) => `[[${path.replace(/\.md$/, '')}${label ? `|${label.replace(/[|\]]/g, '')}` : ''}]]`
export const idShort = (id: string) => id.slice(0, 8)

export function notePath(meta: NoteMeta): string {
  const when = localParts(meta.createdAt, meta.utcOffsetMinutes)
  return `notes/${when.date.slice(0, 4)}/${when.date.slice(5, 7)}/${when.date}-${when.time.replace(':', '')}-${idShort(meta.id)}.md`
}

export const entityPath = (kind: 'person' | 'project', name: string) => `${kind === 'person' ? 'people' : 'projects'}/${slug(name)}.md`

/** Groups transcript segments into readable paragraphs: a pause of two seconds or a long run starts a new one. */
export function paragraphs(transcript: Transcript): string[] {
  if (!transcript.segments.length) return transcript.text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
  const out: string[] = []
  let current = ''
  let previousEnd = 0
  for (const segment of transcript.segments) {
    if (current && (segment.start - previousEnd > 2 || current.length > 600)) { out.push(current); current = '' }
    current = current ? `${current} ${segment.text}` : segment.text
    previousEnd = segment.end
  }
  if (current) out.push(current)
  return out
}

/** The words being spoken around a marked moment. */
export function wordsAt(segments: Segment[], seconds: number): string | null {
  if (!segments.length) return null
  const inside = segments.find(segment => segment.start <= seconds && seconds <= segment.end + 0.5)
  const nearest = inside ?? segments.reduce((best, segment) => Math.abs(segment.start - seconds) < Math.abs(best.start - seconds) ? segment : best)
  return nearest.text.length > 220 ? `${nearest.text.slice(0, 217)}…` : nearest.text
}

const box = (status: TaskStatus | undefined) => (status === 'done' ? '[x]' : status === 'dismissed' ? '[-]' : '[ ]')

export function renderNote(meta: NoteMeta, transcript: Transcript, digest: Digest | null, statuses: Map<number, TaskStatus>): string {
  const when = localParts(meta.createdAt, meta.utcOffsetMinutes)
  const title = digest?.title || meta.title || 'Voice note'
  const tags = [...new Set([...meta.tags, ...(digest?.tags ?? [])])]
  const projects = [...new Set([...(digest?.projects.map(project => project.name) ?? []), ...(digest?.tasks.map(task => task.project).filter((name): name is string => Boolean(name)) ?? [])])]
  const people = digest?.people.map(person => person.name) ?? []
  const lines: string[] = [
    '---',
    `id: ${yaml(meta.id)}`,
    `title: ${yaml(title)}`,
    `recorded: ${yaml(`${when.date}T${when.time}:00${when.offset}`)}`,
    `day: ${yaml(when.date)}`,
    `duration: ${yaml(formatDuration(meta.durationMs))}`,
    `source: ${yaml(meta.source)}`,
    `device: ${yaml(meta.device)}`,
    `tags: ${yaml(tags)}`,
    `projects: ${yaml(projects)}`,
    `people: ${yaml(people)}`,
    `digested: ${digest ? 'true' : 'false'}`,
    'generated: true',
    '---', '', `# ${title}`, '',
  ]
  if (digest?.summary) lines.push(`> ${digest.summary.replace(/\n+/g, ' ')}`, '')
  if (!digest) lines.push('_Transcribed. Summary and tasks have not been extracted yet._', '')
  if (transcript.suspectedSilence) lines.push('> **Possibly no speech.** The recognizer returned only filler. Listen to the audio before trusting this note.', '')

  const quoted = (heading: string, items: Array<{ text: string; quote: string }>) => {
    if (!items.length) return
    lines.push(`## ${heading}`)
    for (const item of items) lines.push(`- ${item.text}`, `  > “${item.quote}”`)
    lines.push('')
  }
  if (digest?.tasks.length) {
    lines.push('## Tasks')
    for (const [index, task] of digest.tasks.entries()) {
      const extra = [task.due ? `due ${task.due}` : '', task.project ? `project ${task.project}` : '', task.priority === 'high' ? 'high priority' : task.priority === 'low' ? 'someday' : ''].filter(Boolean)
      lines.push(`- ${box(statuses.get(index))} ${task.text}${extra.length ? ` · ${extra.join(' · ')}` : ''}`, `  > “${task.quote}”`)
    }
    lines.push('')
  }
  if (digest) {
    quoted('Ideas', digest.ideas)
    quoted('Decisions', digest.decisions)
    quoted('Open questions', digest.questions)
    if (digest.people.length || digest.projects.length) {
      lines.push('## People and projects')
      for (const person of digest.people) lines.push(`- ${wikiLink(entityPath('person', person.name), person.name)}${person.context ? `: ${person.context}` : ''}`)
      for (const project of digest.projects) lines.push(`- ${wikiLink(entityPath('project', project.name), project.name)}${project.context ? `: ${project.context}` : ''}`)
      lines.push('')
    }
  }
  if (meta.marks.length) {
    lines.push('## Marked moments')
    for (const ms of meta.marks) {
      const words = wordsAt(transcript.segments, ms / 1000)
      lines.push(`- \`${formatClock(ms / 1000)}\`${words ? ` “${words}”` : ''}`)
    }
    lines.push('')
  }
  lines.push('## Transcript', '')
  const body = paragraphs(transcript)
  lines.push(...(body.length ? body.flatMap(part => [part, '']) : ['_(empty)_', '']))
  lines.push('---')
  const audio = meta.audioFile ? `audio \`inbox/${meta.id}/${meta.audioFile}\`` : 'no audio (written text)'
  lines.push(`${audio} · transcribed by ${transcript.model}${digest ? ` · digested by ${digest.model}` : ''}${digest?.droppedItems ? ` · ${digest.droppedItems} extracted item(s) left out because they could not be matched to spoken words` : ''}${meta.recovered ? ' · recovered after an interrupted recording' : ''}`, '')
  return lines.join('\n')
}

export function renderDaily(day: string, notes: NoteRow[], tasksByNote: Map<string, TaskRow[]>): string {
  const heading = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
  const lines = ['---', `day: ${yaml(day)}`, 'generated: true', '---', '', `# ${heading}`, '']
  if (!notes.length) lines.push('_No notes._', '')
  for (const note of notes) {
    lines.push(`## ${note.time} ${wikiLink(note.vault_path, note.title)}`, '')
    if (note.summary) lines.push(note.summary, '')
    for (const task of tasksByNote.get(note.id) ?? []) lines.push(`- ${box(task.status)} ${task.text}${task.due ? ` · due ${task.due}` : ''}`)
    if ((tasksByNote.get(note.id) ?? []).length) lines.push('')
  }
  return lines.join('\n')
}

export function renderEntity(kind: 'person' | 'project', name: string, mentions: Array<{ day: string; time: string; title: string; context: string; vault_path: string }>, openTasks: TaskRow[]): string {
  const lines = ['---', `kind: ${yaml(kind)}`, `name: ${yaml(name)}`, 'generated: true', '---', '', `# ${name}`, '', `_${mentions.length} mention${mentions.length === 1 ? '' : 's'} in voice notes. This page is generated; put your own synthesis in \`wiki/\`._`, '']
  if (openTasks.length) {
    lines.push('## Open tasks')
    for (const task of openTasks) lines.push(`- [ ] ${task.text}${task.due ? ` · due ${task.due}` : ''} (${task.day})`)
    lines.push('')
  }
  lines.push('## Mentions')
  for (const mention of mentions) lines.push(`- ${mention.day} ${mention.time} ${wikiLink(mention.vault_path, mention.title)}${mention.context ? `: ${mention.context}` : ''}`)
  lines.push('')
  return lines.join('\n')
}

export function renderTasks(open: TaskRow[], today: string): string {
  const lines = ['---', 'generated: true', '---', '', '# Open tasks', '']
  if (!open.length) return [...lines, '_Nothing open._', ''].join('\n')
  const soon = new Date(`${today}T00:00:00Z`)
  soon.setUTCDate(soon.getUTCDate() + 7)
  const limit = soon.toISOString().slice(0, 10)
  const groups: Array<[string, TaskRow[]]> = [
    ['Overdue', open.filter(task => task.due && task.due < today)],
    ['Next seven days', open.filter(task => task.due && task.due >= today && task.due <= limit)],
    ['Later', open.filter(task => task.due && task.due > limit)],
    ['No date', open.filter(task => !task.due)],
  ]
  for (const [heading, tasks] of groups) {
    if (!tasks.length) continue
    lines.push(`## ${heading}`)
    for (const task of tasks) lines.push(`- [ ] ${task.text}${task.due ? ` · due ${task.due}` : ''}${task.project ? ` · ${task.project}` : ''}${task.priority === 'high' ? ' · high priority' : ''} (${task.day})`)
    lines.push('')
  }
  return lines.join('\n')
}

/** Files on disk plus a git history of every change. All writes go through one queue so commits never collide. */
export class Vault {
  readonly root: string
  readonly gitEnabled: boolean
  private readonly queue = new Mutex()
  private git = false

  constructor(root: string, gitEnabled: boolean) {
    this.root = root
    this.gitEnabled = gitEnabled
  }

  /** Runs `task` after every earlier vault task has finished. */
  exclusive<T>(task: () => Promise<T>): Promise<T> { return this.queue.run(task) }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const dir of ['notes', 'daily', 'projects', 'people', 'wiki', 'schema', 'state']) await mkdir(join(this.root, dir), { recursive: true })
    await this.seed('schema/AGENTS.md', SCHEMA_DOC)
    await this.seed('wiki/index.md', WIKI_INDEX)
    if (this.gitEnabled) {
      try {
        const hasRepo = await stat(join(this.root, '.git')).then(() => true, () => false)
        if (!hasRepo) await exec('git', ['init', '-q', '-b', 'main'], { cwd: this.root })
        this.git = true
        await this.commit('Initialize vault')
      } catch (error) {
        console.warn(`git is unavailable, the vault will not be versioned: ${errorText(error)}`)
      }
    }
  }

  private async seed(rel: string, content: string) {
    try { await stat(join(this.root, rel)) } catch { await writeFileAtomic(join(this.root, rel), content) }
  }

  /** Resolves a vault-relative path and refuses anything that escapes the vault. */
  resolve(rel: string): string {
    const full = resolve(this.root, rel)
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('path escapes the vault')
    return full
  }

  async read(rel: string): Promise<string | null> { try { return await readFile(this.resolve(rel), 'utf8') } catch { return null } }
  async write(rel: string, content: string): Promise<void> { await writeFileAtomic(this.resolve(rel), content) }
  async remove(rel: string): Promise<void> { await rm(this.resolve(rel), { force: true }) }

  async listMarkdown(rel: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string) => {
      let entries
      try { entries = await readdir(join(this.root, dir), { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.name.endsWith('.md')) out.push(path.split(sep).join('/'))
      }
    }
    await walk(rel)
    return out.sort()
  }

  async commit(message: string): Promise<void> {
    if (!this.git) return
    try {
      await exec('git', ['add', '-A'], { cwd: this.root })
      const changed = await exec('git', ['diff', '--cached', '--quiet'], { cwd: this.root }).then(() => false, () => true)
      if (changed) await exec('git', ['-c', 'user.name=voicebrain', '-c', 'user.email=voicebrain@localhost', 'commit', '-q', '-m', message], { cwd: this.root })
    } catch (error) {
      console.warn(`git commit failed: ${errorText(error)}`)
    }
  }
}

