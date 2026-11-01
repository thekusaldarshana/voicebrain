import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { displayTags, displayTitle, userNamed } from './titles.ts'
import type { Digest, NoteEdits, NoteMeta, Transcript, TaskStatus } from './types.ts'
import { localParts, slugify } from './util.ts'

const SCHEMA_VERSION = 1

export interface NoteRow { id: string; recorded_at: string; day: string; time: string; title: string; summary: string; tags: string; source: string; duration_ms: number; device: string; vault_path: string; digested: number; suspected_silence: number }
export interface TaskRow { id: string; note_id: string; idx: number; text: string; due: string | null; project: string | null; priority: string; quote: string; recorded_at: string; status: TaskStatus; note_title: string; day: string }
export interface Hit { kind: 'note' | 'wiki'; ref: string; title: string; snippet: string; day: string | null; time: string | null }
export interface Mention { note_id: string; name: string; context: string; day: string; time: string; title: string; vault_path: string }

type Row = Record<string, unknown>

/** The search index is derived data: delete the file and it is rebuilt from the inbox and the vault. */
export class Index {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== SCHEMA_VERSION) {
      for (const table of ['notes', 'tasks', 'task_status', 'entities', 'wiki', 'docs']) this.db.exec(`DROP TABLE IF EXISTS ${table}`)
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, recorded_at TEXT, day TEXT, time TEXT, title TEXT, summary TEXT, tags TEXT, source TEXT, duration_ms INTEGER, device TEXT, vault_path TEXT, digested INTEGER, suspected_silence INTEGER);
      CREATE INDEX IF NOT EXISTS notes_day ON notes(day, time);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, note_id TEXT, idx INTEGER, text TEXT, due TEXT, project TEXT, priority TEXT, quote TEXT, recorded_at TEXT);
      CREATE INDEX IF NOT EXISTS tasks_note ON tasks(note_id);
      CREATE TABLE IF NOT EXISTS task_status(id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS entities(kind TEXT, slug TEXT, name TEXT, note_id TEXT, context TEXT);
      CREATE INDEX IF NOT EXISTS entities_lookup ON entities(kind, slug);
      CREATE INDEX IF NOT EXISTS entities_note ON entities(note_id);
      CREATE TABLE IF NOT EXISTS wiki(path TEXT PRIMARY KEY, title TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS note_names(id TEXT PRIMARY KEY, user_title TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(kind UNINDEXED, ref UNINDEXED, title, body, tokenize = 'porter unicode61');
    `)
  }

  close() { this.db.close() }

  private all<T = Row>(sql: string, ...params: Array<string | number | null>): T[] { return this.db.prepare(sql).all(...params) as T[] }
  private get<T = Row>(sql: string, ...params: Array<string | number | null>): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined }
  private run(sql: string, ...params: Array<string | number | null>) { this.db.prepare(sql).run(...params) }

  /** Entity slugs this note was indexed under before (so pages for names that changed can be refreshed). */
  entitiesOf(noteId: string): Array<{ kind: string; slug: string; name: string }> {
    return this.all<{ kind: string; slug: string; name: string }>('SELECT DISTINCT kind, slug, name FROM entities WHERE note_id = ?', noteId)
  }

  upsertNote(meta: NoteMeta, transcript: Transcript, digest: Digest | null, vaultPath: string, edits: NoteEdits | null = null): void {
    const when = localParts(meta.createdAt, meta.utcOffsetMinutes)
    const title = displayTitle(meta, digest, edits)
    const tags = displayTags(meta, digest, edits)
    this.db.exec('BEGIN')
    try {
      this.run('INSERT OR REPLACE INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', meta.id, meta.createdAt, when.date, when.time, title, digest?.summary ?? '', JSON.stringify(tags), meta.source, meta.durationMs, meta.device, vaultPath, digest ? 1 : 0, transcript.suspectedSilence ? 1 : 0)
      this.run('INSERT OR REPLACE INTO note_names VALUES (?, ?)', meta.id, userNamed(meta, edits))
      this.run('DELETE FROM tasks WHERE note_id = ?', meta.id)
      for (const [idx, task] of (digest?.tasks ?? []).entries()) {
        this.run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)', `${meta.id}#${idx}`, meta.id, idx, task.text, task.due, task.project, task.priority, task.quote, meta.createdAt)
      }
      this.run('DELETE FROM entities WHERE note_id = ?', meta.id)
      for (const person of digest?.people ?? []) this.run('INSERT INTO entities VALUES (?,?,?,?,?)', 'person', slugify(person.name), person.name, meta.id, person.context)
      for (const project of digest?.projects ?? []) this.run('INSERT INTO entities VALUES (?,?,?,?,?)', 'project', slugify(project.name), project.name, meta.id, project.context)
      for (const task of digest?.tasks ?? []) if (task.project) this.run('INSERT INTO entities SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM entities WHERE kind = ? AND slug = ? AND note_id = ?)', 'project', slugify(task.project), task.project, meta.id, '', 'project', slugify(task.project), meta.id)
      this.run('DELETE FROM docs WHERE kind = ? AND ref = ?', 'note', meta.id)
      const body = [digest?.summary, transcript.text, ...(digest?.ideas ?? []).map(item => item.text), ...(digest?.decisions ?? []).map(item => item.text), ...(digest?.tasks ?? []).map(item => item.text), ...(digest?.questions ?? []).map(item => item.text), tags.join(' ')].filter(Boolean).join('\n')
      this.run('INSERT INTO docs(kind, ref, title, body) VALUES (?,?,?,?)', 'note', meta.id, title, body)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeNote(id: string) {
    for (const sql of ['DELETE FROM notes WHERE id = ?', 'DELETE FROM note_names WHERE id = ?', 'DELETE FROM tasks WHERE note_id = ?', 'DELETE FROM entities WHERE note_id = ?']) this.run(sql, id)
    this.run('DELETE FROM docs WHERE kind = ? AND ref = ?', 'note', id)
    this.run('DELETE FROM task_status WHERE id LIKE ?', `${id}#%`)
  }

  /** Notes whose title matches `text`: exact matches if there are any, otherwise titles that contain it. Newest first. */
  byTitle(text: string, limit = 6): NoteRow[] {
    const exact = this.all<NoteRow>('SELECT * FROM notes WHERE lower(title) = lower(?) ORDER BY recorded_at DESC LIMIT ?', text, limit)
    if (exact.length) return exact
    const like = `%${text.replace(/[\\%_]/g, ch => `\\${ch}`)}%`
    return this.all<NoteRow>("SELECT * FROM notes WHERE title LIKE ? ESCAPE '\\' ORDER BY recorded_at DESC LIMIT ?", like, limit)
  }

  /** Tasks whose text matches `text`, any status, open ones first. */
  findTasks(text: string, limit = 8): TaskRow[] {
    const like = `%${text.replace(/[\\%_]/g, ch => `\\${ch}`)}%`
    return this.all<TaskRow>(
      `SELECT t.*, COALESCE(s.status, 'open') AS status, n.title AS note_title, n.day AS day
         FROM tasks t LEFT JOIN task_status s ON s.id = t.id JOIN notes n ON n.id = t.note_id
        WHERE lower(t.text) = lower(?) OR t.text LIKE ? ESCAPE '\\'
        ORDER BY (COALESCE(s.status, 'open') = 'open') DESC, lower(t.text) = lower(?) DESC, t.recorded_at DESC LIMIT ?`, text, like, text, limit)
  }

  upsertWiki(path: string, title: string, body: string, updatedAt: string) {
    this.run('INSERT OR REPLACE INTO wiki VALUES (?,?,?)', path, title, updatedAt)
    this.run('DELETE FROM docs WHERE kind = ? AND ref = ?', 'wiki', path)
    this.run('INSERT INTO docs(kind, ref, title, body) VALUES (?,?,?,?)', 'wiki', path, title, body)
  }

  removeWiki(path: string) {
    this.run('DELETE FROM wiki WHERE path = ?', path)
    this.run('DELETE FROM docs WHERE kind = ? AND ref = ?', 'wiki', path)
  }

  wikiPaths(): string[] { return this.all<{ path: string }>('SELECT path FROM wiki ORDER BY path').map(row => row.path) }
  /** Whether every note has its name row. An index from before names were kept lacks them and is rebuilt once. */
  namesComplete(): boolean { return (this.get<{ n: number }>('SELECT count(*) AS n FROM notes n WHERE NOT EXISTS (SELECT 1 FROM note_names m WHERE m.id = n.id)') ?? { n: 0 }).n === 0 }

  /** What the app needs to name its notes: the name shown now, and the one the person typed (empty when nobody did). */
  names(limit = 1000): Array<{ id: string; title: string; userTitle: string }> {
    return this.all<{ id: string; title: string; user_title: string | null }>('SELECT n.id AS id, n.title AS title, m.user_title AS user_title FROM notes n LEFT JOIN note_names m ON m.id = n.id ORDER BY n.recorded_at DESC LIMIT ?', limit)
      .map(row => ({ id: row.id, title: row.title, userTitle: row.user_title ?? '' }))
  }

  /** Notes that are written down but not sorted into tasks and ideas yet. A silent recording needs nothing, so it is left out. */
  waitingNotes(limit: number): NoteRow[] {
    return this.all<NoteRow>('SELECT * FROM notes WHERE digested = 0 AND suspected_silence = 0 ORDER BY recorded_at ASC LIMIT ?', limit)
  }
  waitingCount(): number { return (this.get<{ n: number }>('SELECT count(*) AS n FROM notes WHERE digested = 0 AND suspected_silence = 0') ?? { n: 0 }).n }

  noteCount(): number { return (this.get<{ n: number }>('SELECT count(*) AS n FROM notes') ?? { n: 0 }).n }

  /** Ranked search over notes and wiki pages. Every word must match (prefix match); if nothing does, any word may. */
  search(query: string, limit = 8, kind?: 'note' | 'wiki'): Hit[] {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])].slice(0, 12)
    if (!words.length) return []
    const run = (joiner: string) => this.all<Row>(
      `SELECT d.kind AS kind, d.ref AS ref, d.title AS title,
              snippet(docs, 3, '«', '»', ' … ', 24) AS snippet, n.day AS day, n.time AS time
         FROM docs d LEFT JOIN notes n ON d.kind = 'note' AND n.id = d.ref
        WHERE docs MATCH ? ${kind ? 'AND d.kind = ?' : ''}
        ORDER BY bm25(docs, 0, 0, 4.0, 1.0), n.recorded_at DESC, d.ref LIMIT ?`,
      words.map(word => `"${word.replace(/"/g, '')}"*`).join(joiner), ...(kind ? [kind] : []), limit,
    ) as unknown as Hit[]
    const strict = run(' AND ')
    return strict.length || words.length === 1 ? strict : run(' OR ')
  }

  recent(sinceDay: string, limit: number): NoteRow[] {
    return this.all<NoteRow>('SELECT * FROM notes WHERE day >= ? ORDER BY recorded_at DESC LIMIT ?', sinceDay, limit)
  }

  note(id: string): NoteRow | undefined { return this.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id) }

  /** Accepts a full id or the first eight characters shown in the vault. */
  resolveId(idOrPrefix: string): string | null {
    const rows = this.all<{ id: string }>('SELECT id FROM notes WHERE id = ? OR id LIKE ? LIMIT 2', idOrPrefix, `${idOrPrefix.replace(/[%_]/g, '')}%`)
    return rows.length === 1 ? (rows[0] as { id: string }).id : null
  }

  tasksOfNote(noteId: string): TaskRow[] {
    return this.all<TaskRow>(`SELECT t.*, COALESCE(s.status, 'open') AS status, n.title AS note_title, n.day AS day FROM tasks t LEFT JOIN task_status s ON s.id = t.id JOIN notes n ON n.id = t.note_id WHERE t.note_id = ? ORDER BY t.idx`, noteId)
  }

  clear() {
    for (const table of ['notes', 'tasks', 'entities', 'wiki', 'docs']) this.db.exec(`DELETE FROM ${table}`)
  }
  notesForDay(day: string): NoteRow[] { return this.all<NoteRow>('SELECT * FROM notes WHERE day = ? ORDER BY recorded_at, id', day) }

  /** Every day that has a note, and every person or project that has a mention: what a full rebuild must write pages for. */
  days(): string[] { return this.all<{ day: string }>('SELECT DISTINCT day FROM notes ORDER BY day').map(row => row.day) }
  entityKeys(): Array<{ kind: 'person' | 'project'; slug: string }> { return this.all<{ kind: 'person' | 'project'; slug: string }>('SELECT DISTINCT kind, slug FROM entities ORDER BY kind, slug') }

  setTaskStatus(id: string, status: TaskStatus, updatedAt: string) {
    this.run('INSERT OR REPLACE INTO task_status VALUES (?,?,?)', id, status, updatedAt)
  }

  loadTaskStatuses(entries: Record<string, { status: TaskStatus; updatedAt: string }>) {
    this.run('DELETE FROM task_status')
    for (const [id, entry] of Object.entries(entries)) this.setTaskStatus(id, entry.status, entry.updatedAt)
  }

  taskStatuses(noteId: string): Map<number, TaskStatus> {
    const rows = this.all<{ idx: number; status: string }>('SELECT t.idx AS idx, s.status AS status FROM tasks t JOIN task_status s ON s.id = t.id WHERE t.note_id = ?', noteId)
    return new Map(rows.map(row => [row.idx, row.status as TaskStatus]))
  }

  task(id: string): TaskRow | undefined {
    return this.get<TaskRow>(`SELECT t.*, COALESCE(s.status, 'open') AS status, n.title AS note_title, n.day AS day FROM tasks t LEFT JOIN task_status s ON s.id = t.id JOIN notes n ON n.id = t.note_id WHERE t.id = ?`, id)
  }

  /** Open tasks, oldest due first, then oldest recorded. `project` matches by slug. */
  openTasks(project?: string, limit = 200): TaskRow[] {
    return this.all<TaskRow>(
      `SELECT t.*, COALESCE(s.status, 'open') AS status, n.title AS note_title, n.day AS day
         FROM tasks t LEFT JOIN task_status s ON s.id = t.id JOIN notes n ON n.id = t.note_id
        WHERE COALESCE(s.status, 'open') = 'open' ${project ? 'AND t.project IS NOT NULL AND lower(replace(t.project, \' \', \'-\')) LIKE ?' : ''}
        ORDER BY t.due IS NULL, t.due, t.recorded_at, t.note_id, t.idx LIMIT ?`,
      ...(project ? [`%${slugify(project)}%`] : []), limit,
    )
  }

  mentions(kind: 'person' | 'project', slug: string, limit = 50): Mention[] {
    return this.all<Mention>(
      `SELECT e.note_id AS note_id, e.name AS name, e.context AS context, n.day AS day, n.time AS time, n.title AS title, n.vault_path AS vault_path
         FROM entities e JOIN notes n ON n.id = e.note_id WHERE e.kind = ? AND e.slug = ? ORDER BY n.recorded_at DESC, n.id LIMIT ?`, kind, slug, limit)
  }

  /** Entities whose names or slugs overlap the words of `topic`. */
  entitiesMatching(topic: string): Array<{ kind: 'person' | 'project'; slug: string; name: string; mentions: number }> {
    const words = [...new Set(topic.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length > 2)
    const found = new Map<string, { kind: 'person' | 'project'; slug: string; name: string; mentions: number }>()
    for (const word of words) {
      for (const row of this.all<{ kind: 'person' | 'project'; slug: string; name: string; mentions: number }>('SELECT kind, slug, min(name) AS name, count(*) AS mentions FROM entities WHERE slug LIKE ? GROUP BY kind, slug', `%${word}%`)) {
        found.set(`${row.kind}:${row.slug}`, row)
      }
    }
    return [...found.values()].sort((a, b) => b.mentions - a.mentions).slice(0, 6)
  }

  /** Names already in use, so the model keeps spelling them the same way. */
  knownEntities(): { projects: string[]; people: string[] } {
    const top = (kind: string) => this.all<{ name: string }>('SELECT min(name) AS name FROM entities WHERE kind = ? GROUP BY slug ORDER BY count(*) DESC LIMIT 40', kind).map(row => row.name)
    return { projects: top('project'), people: top('person') }
  }
}
