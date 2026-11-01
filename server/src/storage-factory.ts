import { join } from 'node:path'
import type { StorageConfig } from './config.ts'
import type { DriveTokenProvider } from './drive-tokens.ts'
import { DriveStorage } from './storage-drive.ts'
import { LocalStorage } from './storage-local.ts'
import type { NoteStorage } from './storage.ts'

/** What a backend may need from the rest of the server. The Drive backend needs the user's Drive access tokens. */
export interface StorageDeps { driveTokens?: DriveTokenProvider }

/** Picks the backend named by STORAGE_BACKEND. */
export function createStorage(dataDir: string, settings: StorageConfig, deps: StorageDeps = {}): NoteStorage {
  switch (settings.backend) {
    case 'local': return new LocalStorage(dataDir)
    case 'drive': {
      if (!deps.driveTokens) throw new Error('STORAGE_BACKEND=drive needs a Drive token provider: pass { driveTokens } to createStorage where the Brain is built.')
      return new DriveStorage({ tokens: deps.driveTokens, retainAudio: settings.retainAudio, cacheDir: join(dataDir, 'cache', 'drive') })
    }
  }
}
