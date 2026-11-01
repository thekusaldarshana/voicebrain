import { useMemo, useRef, useState } from 'react'
import { FileUp, RotateCw, Search } from 'lucide-react'
import { NoteRow } from '../components/NoteRow'
import { dayHeading, dayKey, defaultTitle } from '../lib/format'
import { scheduleDelete, useNotes, useNow, useToast } from '../lib/hooks'
import { importAudioFile, retryFailed } from '../lib/notes'
import { kickUploads } from '../lib/uploader'
import type { Note } from '../lib/types'

type Filter = 'all' | 'waiting' | 'uploaded' | 'attention'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'uploaded', label: 'Uploaded' },
  { id: 'attention', label: 'Needs attention' },
]

const matches = (note: Note, filter: Filter) =>
  filter === 'all' || (filter === 'waiting' && (note.status === 'local' || note.status === 'uploading'))
  || (filter === 'uploaded' && note.status === 'uploaded') || (filter === 'attention' && note.status === 'failed')

export function LibraryPage() {
  const { notes, ready } = useNotes()
  const now = useNow(5000)
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const picker = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase()
    return notes.filter(note => note.status !== 'recording' && matches(note, filter)
      && (!text || `${note.title} ${note.remoteTitle ?? ''} ${defaultTitle(note.createdAt)} ${note.tags.join(' ')}`.toLowerCase().includes(text)))
  }, [notes, query, filter])

  const groups = useMemo(() => {
    const map = new Map<string, Note[]>()
    for (const note of visible) map.set(dayKey(note.createdAt), [...(map.get(dayKey(note.createdAt)) ?? []), note])
    return [...map.entries()]
  }, [visible])

  const attention = notes.filter(note => note.status === 'failed').length
  const today = dayKey(now)

  const onDelete = (note: Note) => {
    const cancel = scheduleDelete(note.id)
    const unsent = note.status !== 'uploaded'
    toast(unsent ? 'Deleted. This note had not been uploaded.' : 'Removed from this device. The server keeps its copy.', { actionLabel: 'Undo', onAction: cancel, durationMs: 7000 })
  }

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return
    let count = 0
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('audio/') && !/\.(m4a|mp3|wav|ogg|opus|aac|flac|webm)$/i.test(file.name)) continue
      await importAudioFile(file)
      count += 1
    }
    if (picker.current) picker.current.value = ''
    toast(count ? `Added ${count} ${count === 1 ? 'recording' : 'recordings'} to the upload queue.` : 'No audio files were found in that selection.')
    if (count) kickUploads()
  }

  return <main className="page library-page">
    <div className="shell">
      <p className="eyebrow">Everything you have recorded</p>
      <h1>Library</h1>

      <div className="library-tools">
        <div className="search-wrap">
          <Search size={15} aria-hidden="true" />
          <input className="search" type="search" placeholder="Search titles and tags" aria-label="Search notes" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="filters" role="group" aria-label="Filter by status">
          {FILTERS.map(item => <button key={item.id} type="button" className="filter" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}
        </div>
        <button type="button" className="secondary-button" onClick={() => picker.current?.click()}><FileUp size={14} aria-hidden="true" />Import audio</button>
        <input ref={picker} type="file" accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.aac,.flac,.webm" multiple hidden onChange={event => void onImport(event.target.files)} />
      </div>

      {attention > 0 && <div className="banner" role="status">
        <span>{attention} {attention === 1 ? 'note needs' : 'notes need'} attention. Fix the connection in Settings, then retry.</span>
        <button type="button" className="secondary-button" onClick={async () => { await retryFailed(); kickUploads({ force: true, ignoreBackoff: true }) }}><RotateCw size={14} aria-hidden="true" />Retry all</button>
      </div>}

      {!ready ? <p className="empty">Loading…</p>
        : groups.length === 0 ? <p className="empty">{notes.length ? 'No notes match.' : 'No notes yet. Record one and it will show up here.'}</p>
        : groups.map(([key, items]) => <section key={key} className="day-group" aria-label={dayHeading(key, today)}>
          <h2>{dayHeading(key, today)}<span className="count">{items.length}</span></h2>
          <ul className="note-list">{items.map(note => <NoteRow key={note.id} note={note} now={now} onDelete={onDelete} />)}</ul>
        </section>)}
    </div>
  </main>
}
