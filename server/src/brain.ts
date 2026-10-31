import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { Config } from './config.ts'
import type { Hit, NoteRow, TaskRow } from './index.ts'
import { Index } from './index.ts'
import { Store } from './store.ts'
import type { NoteMeta, TaskStatus, TaskStatusEntry } from './types.ts'
import { Vault, entityPath, notePath, renderDaily, renderEntity, renderNote, renderTasks } from './vault.ts'
import { PermanentError, readJson, writeJson } from './util.ts'
import { join } from 'node:path'

const STATUS_FILE = 'state/task-status.json'
const WIKI_PATH = /^[A-Za-z0-9][A-Za-z0-9 _\-./]*\.md$/
const MAX_WIKI_BYTES = 200_000

/** Offset of an IANA zone from UTC at `date`, in minutes. */
export function tzOffsetMinutes(timeZone: string, date: Date): number {
  const whole = new Date(Math.floor(date.getTime() / 1000) * 1000)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(whole)
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - whole.getTime()) / 60_000)
}

export interface Brief {
  topic: string
  notes: Hit[]
  tasks: TaskRow[]
  entities: Array<{ kind: 'person' | 'project'; name: string; mentions: number; last: { day: string; title: string } | null }>
  wiki: Hit[]
  overdue: TaskRow[]
  today: string
}

/** Everything the assistant and the pipeline need, over the inbox files, the vault and the index. */
export class Brain {
  readonly config: Config
  readonly store: Store
  readonly index: Index
  readonly vault: Vault
  readonly now: () => Date
  /** Called after something new needs processing (a text note added from chat). */
  onNewWork: () => void = () => undefined

  constructor(config: Config, now: () => Date = () => new Date()) {
    this.config = config
    this.now = now
    this.store = new Store(config.dataDir)
    this.index = new Index(join(config.dataDir, 'index.sqlite'))
    this.vault = new Vault(this.store.vault, config.gitEnabled)
  }

  today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.config.ownerTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now())
  }

  async init(): Promise<void> {
    await this.vault.init()
    const ids = await this.store.ids()
    let withTranscript = 0
    for (const id of ids) if (await this.store.transcript(id)) withTranscript += 1
    if (process.env.REINDEX === '1' || this.index.noteCount() !== withTranscript) await this.reindex()
    else await this.syncWiki()
  }

  private async statuses(): Promise<Record<string, TaskStatusEntry>> {
    return (await readJson<Record<string, TaskStatusEntry>>(join(this.vault.root, STATUS_FILE))) ?? {}
  }

  /** Rebuilds the whole search index from the inbox and vault files. Nothing in the vault is rewritten. */
  async reindex(): Promise<number> {
    this.index.clear()
    this.index.loadTaskStatuses(await this.statuses())
    let count = 0
    for (const id of await this.store.ids()) {
      const [meta, transcript] = await Promise.all([this.store.meta(id), this.store.transcript(id)])
      if (!meta || !transcript) continue
      this.index.upsertNote(meta, transcript, await this.store.digest(id), notePath(meta))
      count += 1
    }
    await this.syncWiki()
    return count
  }

  /** Picks up wiki pages edited outside the server (git, Obsidian) and forgets deleted ones. */
  async syncWiki(): Promise<void> {
    const onDisk = await this.vault.listMarkdown('wiki')
    for (const path of this.index.wikiPaths()) if (!onDisk.includes(path)) this.index.removeWiki(path)
    for (const path of onDisk) {
      const [body, info] = [await this.vault.read(path), await stat(this.vault.resolve(path))]
      if (body !== null) this.index.upsertWiki(path, /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? path.replace(/^wiki\//, ''), body, info.mtime.toISOString())
    }
  }

  /** Renders the vault note and its generated views, and indexes it. Safe to run again any time. */
  fileNote(id: string): Promise<void> {
    return this.vault.exclusive(async () => {
      await this.fileNoteLocked(id)
      const row = this.index.note(id)
      if (row) await this.vault.commit(`${row.day} ${row.time} ${row.title}`)
    })
  }

  private async fileNoteLocked(id: string): Promise<void> {
    const [meta, transcript, digest] = await Promise.all([this.store.meta(id), this.store.transcript(id), this.store.digest(id)])
    if (!meta || !transcript) return
    const before = this.index.entitiesOf(id)
    const path = notePath(meta)
    await this.vault.write(path, renderNote(meta, transcript, digest, this.index.taskStatuses(id)))
    this.index.upsertNote(meta, transcript, digest, path)
    const row = this.index.note(id) as NoteRow
    await this.refreshDay(row.day)
    const seen = new Set<string>()
    for (const entity of [...before, ...this.index.entitiesOf(id)]) {
      const key = `${entity.kind}:${entity.slug}`
      if (seen.has(key)) continue
      seen.add(key)
      await this.refreshEntity(entity.kind as 'person' | 'project', entity.slug)
    }
    await this.vault.write('tasks.md', renderTasks(this.index.openTasks(), this.today()))
  }

  private async refreshDay(day: string): Promise<void> {
    const notes = this.index.notesForDay(day)
    await this.vault.write(`daily/${day}.md`, renderDaily(day, notes, new Map(notes.map(note => [note.id, this.index.tasksOfNote(note.id)]))))
  }

  private async refreshEntity(kind: 'person' | 'project', slug: string): Promise<void> {
    const mentions = this.index.mentions(kind, slug, 200)
    const path = `${kind === 'person' ? 'people' : 'projects'}/${slug}.md`
    const first = mentions[0]
    if (!first) { await this.vault.remove(path); return }
    await this.vault.write(path, renderEntity(kind, first.name, mentions, kind === 'project' ? this.index.openTasks(slug) : []))
  }

  // ---- what the assistant asks for ----

  search(query: string, limit = 8, kind?: 'note' | 'wiki'): Hit[] { return this.index.search(query, Math.min(limit, 25), kind) }

  recent(days: number, limit: number): NoteRow[] {
    const since = new Date(this.now().getTime() - Math.max(0, days) * 86_400_000)
    return this.index.recent(new Intl.DateTimeFormat('en-CA', { timeZone: this.config.ownerTimezone }).format(since), Math.min(limit, 50))
  }

  async getNote(idOrPrefix: string): Promise<{ id: string; markdown: string } | null> {
    const id = this.index.resolveId(idOrPrefix)
    const row = id ? this.index.note(id) : undefined
    if (!id || !row) return null
    const markdown = await this.vault.read(row.vault_path)
    return markdown === null ? null : { id, markdown }
  }

  openLoops(project?: string): TaskRow[] { return this.index.openTasks(project, 100) }

  /** One call that answers "what do I already know about this?" Used at the start of any task. */
  brief(topic: string): Brief {
    const today = this.today()
    const words = [...new Set(topic.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length > 2)
    const open = this.index.openTasks(undefined, 200)
    const entities = this.index.entitiesMatching(topic)
    const entitySlugs = new Set(entities.filter(entity => entity.kind === 'project').map(entity => entity.slug))
    const tasks = words.length
      ? open.filter(task => {
        const haystack = `${task.text} ${task.project ?? ''} ${task.quote}`.toLowerCase()
        return words.some(word => haystack.includes(word)) || (task.project !== null && [...entitySlugs].some(slug => task.project?.toLowerCase().replace(/[^a-z0-9]+/g, '-').includes(slug)))
      }).slice(0, 10)
      : open.filter(task => task.due !== null && task.due <= today).slice(0, 10)
    return {
      topic,
      notes: words.length ? this.index.search(topic, 6, 'note') : this.recent(3, 5).map(note => ({ kind: 'note', ref: note.id, title: note.title, snippet: note.summary, day: note.day, time: note.time })),
      tasks,
      entities: entities.map(entity => {
        const last = this.index.mentions(entity.kind, entity.slug, 1)[0]
        return { kind: entity.kind, name: entity.name, mentions: entity.mentions, last: last ? { day: last.day, title: last.title } : null }
      }),
      wiki: words.length ? this.index.search(topic, 4, 'wiki') : [],
      overdue: open.filter(task => task.due !== null && task.due < today).slice(0, 8),
      today,
    }
  }

  updateTask(taskId: string, status: TaskStatus): Promise<TaskRow | null> {
    return this.vault.exclusive(async () => {
      const task = this.index.task(taskId)
      if (!task) return null
      const all = await this.statuses()
      const updatedAt = this.now().toISOString()
      all[taskId] = { status, updatedAt }
      await writeJson(join(this.vault.root, STATUS_FILE), all)
      this.index.setTaskStatus(taskId, status, updatedAt)
      await this.fileNoteLocked(task.note_id)
      await this.vault.commit(`task ${status}: ${task.text.slice(0, 60)}`)
      return this.index.task(taskId) ?? null
    })
  }

  /** A note written in chat ("remember that…"). It goes through the same digest step as spoken notes. */
  async addTextNote(text: string, title = ''): Promise<string> {
    const now = this.now()
    const meta: NoteMeta = {
      id: randomUUID(), createdAt: now.toISOString(), durationMs: 0, mime: 'text/plain', size: text.length, title: title.slice(0, 140),
      tags: [], marks: [], recovered: false, source: 'text', device: 'assistant', timezone: this.config.ownerTimezone,
      utcOffsetMinutes: tzOffsetMinutes(this.config.ownerTimezone, now), app: 'mcp', receivedAt: now.toISOString(), audioFile: null, audioBytes: 0,
    }
    await this.store.saveTextNote(meta, text)
    await this.fileNote(meta.id)
    this.onNewWork()
    return meta.id
  }

  wikiList(): string[] { return this.index.wikiPaths() }

  private wikiRel(path: string): string {
    const clean = path.replace(/^\/+/, '').replace(/^wiki\//, '')
    if (!WIKI_PATH.test(clean) || clean.includes('..') || clean.split('/').length > 4 || clean.split('/').some(part => part.startsWith('.'))) {
      throw new PermanentError('Wiki paths look like "projects/trapper.md": letters, numbers, spaces, dashes, up to three folders, ending in .md.')
    }
    return `wiki/${clean}`
  }

  async wikiRead(path: string): Promise<string | null> { return this.vault.read(this.wikiRel(path)) }

  async wikiWrite(path: string, content: string, mode: 'replace' | 'append'): Promise<{ path: string; bytes: number }> {
    const rel = this.wikiRel(path)
    return this.vault.exclusive(async () => {
      const existing = mode === 'append' ? await this.vault.read(rel) : null
      const next = existing ? `${existing.replace(/\s+$/, '')}\n\n${content}\n` : content.endsWith('\n') ? content : `${content}\n`
      if (Buffer.byteLength(next) > MAX_WIKI_BYTES) throw new PermanentError(`That page would be over ${MAX_WIKI_BYTES / 1000} KB. Split it into several pages.`)
      await this.vault.write(rel, next)
      this.index.upsertWiki(rel, /^#\s+(.+)$/m.exec(next)?.[1]?.trim() ?? rel.replace(/^wiki\//, ''), next, this.now().toISOString())
      await this.vault.commit(`wiki: ${mode} ${rel}`)
      return { path: rel, bytes: Buffer.byteLength(next) }
    })
  }

  close() { this.index.close() }
}

export { entityPath }
