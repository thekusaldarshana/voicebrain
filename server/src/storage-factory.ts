import type { StorageConfig } from './config.ts'
import { LocalStorage } from './storage-local.ts'
import type { NoteStorage } from './storage.ts'

/** Picks the backend named by STORAGE_BACKEND. */
export function createStorage(dataDir: string, settings: StorageConfig): NoteStorage {
  switch (settings.backend) {
    case 'local': return new LocalStorage(dataDir)
  }
}
