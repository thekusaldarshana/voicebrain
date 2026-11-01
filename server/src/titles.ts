import type { Digest, NoteEdits, NoteMeta } from './types.ts'

/**
 * The name shown for a note: what the user typed, else what the assistant chose, else the model's title.
 * The title sent with the upload counts as the user's own (they typed it in the recorder).
 */
export function displayTitle(meta: Pick<NoteMeta, 'title'>, digest: Pick<Digest, 'title'> | null, edits: NoteEdits | null | undefined): string {
  const user = edits?.userTitle !== undefined ? edits.userTitle : meta.title
  return user.trim() || edits?.assistantTitle?.trim() || digest?.title?.trim() || 'Voice note'
}

/** Whether the user has named this note themselves. */
export function userNamed(meta: Pick<NoteMeta, 'title'>, edits: NoteEdits | null | undefined): string {
  return (edits?.userTitle !== undefined ? edits.userTitle : meta.title).trim()
}

export function displayTags(meta: Pick<NoteMeta, 'tags'>, digest: Pick<Digest, 'tags'> | null, edits: NoteEdits | null | undefined): string[] {
  return [...new Set([...(edits?.tags ?? meta.tags), ...(digest?.tags ?? [])])]
}

/** Titles end up in tool output and file names, so keep them to one tidy line. */
export function cleanTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) : ''
}

export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const tag of value) {
    if (typeof tag !== 'string') continue
    const clean = tag.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40)
    if (clean) seen.add(clean)
  }
  return [...seen].slice(0, 12)
}
