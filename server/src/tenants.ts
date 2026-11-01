import { join } from 'node:path'
import { Brain } from './brain.ts'
import type { Config } from './config.ts'
import { Pipeline, type PipelineOptions } from './pipeline.ts'
import { checkUser, type NewNote, type NoteStorage, type Payload, type RetainAudio, type StoredStream } from './storage.ts'
import { OWNER_ID } from './users.ts'

/**
 * One user's view of a shared storage. Whatever user id the caller passes (a `Store` always passes the owner's), the
 * calls go to this user's notes, so a `Brain` written for one person can serve any person without being told who.
 */
export class ScopedStorage implements NoteStorage {
  private readonly inner: NoteStorage
  private readonly userId: string

  constructor(inner: NoteStorage, userId: string) { this.inner = inner; this.userId = checkUser(userId) }

  get retainAudio(): RetainAudio { return this.inner.retainAudio }
  listNotes(_user: string): Promise<string[]> { return this.inner.listNotes(this.userId) }
  hasNote(_user: string, noteId: string): Promise<boolean> { return this.inner.hasNote(this.userId, noteId) }
  createNote(_user: string, noteId: string, note: NewNote): Promise<boolean> { return this.inner.createNote(this.userId, noteId, note) }
  list(_user: string, noteId: string): Promise<string[]> { return this.inner.list(this.userId, noteId) }
  get(_user: string, noteId: string, filename: string): Promise<Uint8Array | null> { return this.inner.get(this.userId, noteId, filename) }
  put(_user: string, noteId: string, filename: string, data: Payload): Promise<void> { return this.inner.put(this.userId, noteId, filename, data) }
  getStream(_user: string, noteId: string, filename: string): Promise<StoredStream | null> { return this.inner.getStream(this.userId, noteId, filename) }
  deleteNote(_user: string, noteId: string): Promise<void> { return this.inner.deleteNote(this.userId, noteId) }
  releaseAudio(_user: string, noteId: string): Promise<void> { return this.inner.releaseAudio(this.userId, noteId) }
}

export interface Tenant { userId: string; brain: Brain; pipeline: Pipeline }

/**
 * One brain per person: their own notes, their own search index and their own vault, so nothing one person asks can
 * reach another's. The legacy `owner` identity keeps today's paths (`inbox/`, `vault/`, `index.sqlite` straight in the
 * data folder); every other user lives under `users/<id>/`. Tenants are never deleted: taking someone off the
 * allowlist cuts their access (every route checks it), and their data stays where it is for when they come back.
 */
export class Tenants {
  readonly owner: Tenant
  private readonly config: Config
  private readonly options: PipelineOptions
  private readonly others = new Map<string, Promise<Tenant>>()
  private running = false

  constructor(config: Config, options: PipelineOptions = {}) {
    this.config = config
    this.options = options
    const brain = new Brain(config)
    const pipeline = new Pipeline(brain, options)
    brain.onNewWork = () => pipeline.kick()
    this.owner = { userId: OWNER_ID, brain, pipeline }
  }

  /** The tenant for this user, created (and its index checked) the first time it is asked for. */
  for(userId: string): Promise<Tenant> {
    if (userId === OWNER_ID) return Promise.resolve(this.owner)
    checkUser(userId)
    let tenant = this.others.get(userId)
    if (!tenant) {
      tenant = this.open(userId)
      this.others.set(userId, tenant)
      tenant.catch(() => this.others.delete(userId)) // a failed start can be tried again
    }
    return tenant
  }

  private async open(userId: string): Promise<Tenant> {
    const config: Config = { ...this.config, dataDir: join(this.config.dataDir, 'users', userId) }
    const brain = new Brain(config, undefined, new ScopedStorage(this.owner.brain.store.storage, userId))
    const pipeline = new Pipeline(brain, this.options)
    brain.onNewWork = () => pipeline.kick()
    await brain.init()
    if (this.running && config.workerEnabled) pipeline.start()
    return { userId, brain, pipeline }
  }

  async start(userIds: string[]): Promise<void> {
    await this.owner.brain.init()
    this.running = true
    if (this.config.workerEnabled) this.owner.pipeline.start()
    for (const id of userIds) await this.for(id)
    if (this.config.workerEnabled) for (const tenant of await this.settled()) tenant.pipeline.start()
  }

  private async settled(): Promise<Tenant[]> {
    return (await Promise.allSettled(this.others.values())).flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
  }

  async close(): Promise<void> {
    const all = [this.owner, ...(await this.settled())]
    await Promise.all(all.map(tenant => tenant.pipeline.stop()))
    for (const tenant of all) tenant.brain.close()
  }
}
