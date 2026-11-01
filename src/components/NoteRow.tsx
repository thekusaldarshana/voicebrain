import { useEffect, useRef, useState } from 'react'
import { Bookmark, ChevronDown, Download, ExternalLink, RotateCw, Trash2, Upload } from 'lucide-react'
import { getAudio } from '../lib/db'
import { clockTime, defaultTitle, formatBytes, formatClock, formatDuration, parseTags } from '../lib/format'
import { deleteEverywhere, downloadNote, renameNote, retryNote, setNoteTags } from '../lib/notes'
import { isConfigured } from '../lib/endpoint'
import { errorMessage } from '../lib/errors'
import { kickUploads } from '../lib/uploader'
import { useOnline, useSettings, useToast } from '../lib/hooks'
import type { Note } from '../lib/types'
import { describeStatus } from '../lib/statusView'
import { StatusLabel } from './StatusLabel'

export function NoteRow({ note, now, onDelete }: { note: Note; now: number; onDelete: (note: Note) => void }) {
  const [open, setOpen] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [tagsDraft, setTagsDraft] = useState<string | null>(null)
  const title = titleDraft ?? note.title
  const tags = tagsDraft ?? note.tags.join(', ')
  const player = useRef<HTMLAudioElement>(null)
  const { settings } = useSettings()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const online = useOnline()
  const view = describeStatus(note, settings, now, online)
  const heading = note.title || note.remoteTitle || defaultTitle(note.createdAt)
  const panel = `note-${note.id}`

  // Deleting from the server cannot be undone, so it takes two deliberate taps; the second must come within a few seconds.
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 6000)
    return () => clearTimeout(timer)
  }, [confirming])

  useEffect(() => {
    if (!open || note.audioRemoved) return
    let url: string | null = null
    let cancelled = false
    void getAudio(note.id).then(blob => {
      if (!blob || cancelled) return
      url = URL.createObjectURL(blob)
      setAudioUrl(url)
    })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); setAudioUrl(null) }
  }, [open, note.id, note.audioRemoved])

  const canDeleteEverywhere = note.status === 'uploaded' && isConfigured(settings)
  const deleteForGood = async () => {
    if (!confirming) { setConfirming(true); return }
    setDeleting(true)
    try {
      await deleteEverywhere(note.id)
      toast('Deleted everywhere: the recording and its transcript are gone from your server and this device.')
    } catch (error) {
      setConfirming(false)
      setDeleting(false)
      toast(`Nothing was deleted. ${errorMessage(error)}`)
    }
  }

  const retry = async () => {
    if (note.status === 'failed') await retryNote(note.id)
    kickUploads({ force: true, ignoreBackoff: true, onlyId: note.id })
  }

  return <li className="note-row" data-status={note.status}>
    <button type="button" className="note-summary" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
      <span className="note-main">
        <span className="note-title">{heading}</span>
        <span className="note-meta">{clockTime(note.createdAt)} · {formatDuration(note.durationMs)} · {formatBytes(note.size)}{note.recovered ? ' · recovered' : ''}</span>
        <StatusLabel view={view} />
      </span>
      <ChevronDown size={16} aria-hidden="true" className="note-chevron" />
    </button>
    {open && <div className="note-detail" id={panel}>
      {note.audioRemoved
        ? <p className="hint">The audio was removed from this device after it uploaded. The server has the copy.</p>
        : audioUrl ? <audio ref={player} src={audioUrl} controls preload="metadata" aria-label={`Playback: ${heading}`} /> : <p className="hint">Loading audio…</p>}
      {note.marks.length > 0 && <div className="marks">
        <span className="field-label">Marked moments</span>
        <div className="mark-list">
          {note.marks.map((ms, index) => <button key={`${ms}-${index}`} type="button" className="chip" disabled={!audioUrl}
            onClick={() => { if (player.current) { player.current.currentTime = ms / 1000; void player.current.play() } }}>
            <Bookmark size={12} aria-hidden="true" />{formatClock(ms).slice(3)}
          </button>)}
        </div>
      </div>}
      <label className="field">
        <span className="field-label">Title</span>
        <input value={title} placeholder={note.remoteTitle || defaultTitle(note.createdAt)} maxLength={140} onChange={event => setTitleDraft(event.target.value)}
          onBlur={() => { if (title.trim() !== note.title) void renameNote(note.id, title); setTitleDraft(null) }}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      </label>
      <label className="field">
        <span className="field-label">Tags</span>
        <input value={tags} placeholder="idea, work, personal" onChange={event => setTagsDraft(event.target.value)}
          onBlur={() => { const next = parseTags(tags); if (next.join() !== note.tags.join()) void setNoteTags(note.id, next); setTagsDraft(null) }}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      </label>
      {note.status === 'uploaded' && <p className="hint">{note.editPending ? 'Your change is saved here and will reach your server as soon as it can.' : 'Names and tags you change here also update your server.'}</p>}
      <div className="row-actions">
        {(note.status === 'local' || note.status === 'failed') && <button type="button" className="secondary-button" onClick={retry}>
          {note.status === 'failed' ? <RotateCw size={14} aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
          {note.status === 'failed' ? 'Retry upload' : 'Upload now'}
        </button>}
        {note.driveUrl && <a className="secondary-button" href={note.driveUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Open in Google Drive</a>}
        {!note.audioRemoved && <button type="button" className="secondary-button" onClick={() => void downloadNote(note.id)}><Download size={14} aria-hidden="true" />Download</button>}
        <button type="button" className="secondary-button" onClick={() => onDelete(note)}><Trash2 size={14} aria-hidden="true" />{note.status === 'uploaded' ? 'Remove from this device' : 'Delete'}</button>
        {canDeleteEverywhere && <button type="button" className="secondary-button danger" onClick={() => void deleteForGood()} disabled={deleting} aria-live="polite">
          <Trash2 size={14} aria-hidden="true" />{deleting ? 'Deleting…' : confirming ? 'Tap again to delete everywhere' : 'Delete everywhere'}
        </button>}
      </div>
    </div>}
  </li>
}
