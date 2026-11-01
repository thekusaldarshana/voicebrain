import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, CloudOff, Mic, Pause, Play, Square } from 'lucide-react'
import { Waveform } from '../components/Waveform'
import { StatusLabel } from '../components/StatusLabel'
import { describeStatus } from '../lib/statusView'
import { clockTime, defaultTitle, formatClock, formatDuration } from '../lib/format'
import { isConfigured } from '../lib/endpoint'
import { useNotes, useNow, useOnline, useRecorder, useSettings } from '../lib/hooks'
import { recorder } from '../lib/recorder'

function Clock() {
  const snapshot = useRecorder()
  // Tagged with the note id so a new recording never shows the previous recording's last time.
  const [reading, setReading] = useState<{ noteId: string | null; ms: number }>({ noteId: null, ms: 0 })
  const live = snapshot.state === 'recording' || snapshot.state === 'paused'
  const ms = live && reading.noteId === snapshot.noteId ? reading.ms : 0
  useEffect(() => {
    if (!live) return
    const tick = () => setReading({ noteId: snapshot.noteId, ms: recorder.elapsedMs() })
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 250)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [live, snapshot.noteId])

  useEffect(() => {
    const original = 'voicebrain'
    document.title = snapshot.state === 'recording' ? `● ${formatClock(ms).slice(3)} · ${original}` : snapshot.state === 'paused' ? `Paused · ${original}` : original
    return () => { document.title = original }
  }, [snapshot.state, ms])

  return <p className="timer-display" aria-hidden="true">{formatClock(ms)}</p>
}

const STATE_LABEL = { idle: 'Ready', starting: 'Starting', recording: 'Recording', paused: 'Paused', stopping: 'Saving' } as const

export function RecordPage() {
  const snapshot = useRecorder()
  const { settings } = useSettings()
  const { notes } = useNotes()
  const online = useOnline()
  const now = useNow(1000)
  const [justSavedId, setJustSavedId] = useState<string | null>(null)
  const autoStarted = useRef(false)

  const active = snapshot.state === 'recording' || snapshot.state === 'paused'
  const busy = snapshot.state === 'starting' || snapshot.state === 'stopping'

  const toggle = useCallback(async () => {
    if (snapshot.state === 'recording' || snapshot.state === 'paused') {
      const saved = await recorder.stop()
      if (saved) setJustSavedId(saved.id)
    } else if (snapshot.state === 'idle') {
      setJustSavedId(null)
      await recorder.start(settings)
    }
  }, [snapshot.state, settings])

  useEffect(() => {
    if (autoStarted.current) return
    autoStarted.current = true
    const params = new URLSearchParams(window.location.search)
    const requested = params.get('record') === '1'
    if (requested) {
      params.delete('record')
      const query = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
    }
    if ((requested || settings.recordOnOpen) && recorder.getSnapshot().state === 'idle') void recorder.start(settings)
  }, [settings])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, audio, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        // A focused button or link already handles Space itself.
        if (target?.closest('button, a')) return
        event.preventDefault()
        void toggle()
      } else if (event.key.toLowerCase() === 'm') recorder.mark()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])

  const saved = notes.find(note => note.id === justSavedId)
  const recent = notes.filter(note => note.status !== 'recording').slice(0, 6)
  const connected = isConfigured(settings)

  let message = ''
  if (snapshot.error) message = snapshot.error
  else if (snapshot.warning) message = snapshot.warning
  else if (snapshot.state === 'recording') message = snapshot.marks ? `Recording · ${snapshot.marks} ${snapshot.marks === 1 ? 'moment' : 'moments'} marked` : 'Recording. Audio is saved on this device as you speak.'
  else if (snapshot.state === 'paused') message = 'Paused. Resume or stop to save.'
  else if (snapshot.state === 'stopping') message = 'Saving…'
  else if (saved) message = `Saved ${formatDuration(saved.durationMs)}. ${describeStatus(saved, settings, now, online).text}.`
  else message = connected ? 'Tap record. After you stop, saving and uploading happen on their own.' : 'Tap record. Your notes are kept on this device until you connect.'

  return <main className="page record-page">
    <div className="shell record-layout">
      <section className="record-column" aria-labelledby="record-title">
        <p className="eyebrow">{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date(now))}</p>
        <h1 id="record-title">Record</h1>

        <div className="timer-card">
          <div className="timer-top">
            <span className="timer-label">{STATE_LABEL[snapshot.state]}</span>
            {!online ? <span className="chip-note"><CloudOff size={12} aria-hidden="true" />Offline · saves here, sends later</span>
              : !connected ? <span className="chip-note">Not connected</span> : null}
          </div>
          <Clock />
          <Waveform state={snapshot.state} />

          <div className="record-controls">
            <div className="control">
              <button type="button" className="round-button" onClick={() => (snapshot.state === 'paused' ? recorder.resume() : recorder.pause())} disabled={!active} aria-label={snapshot.state === 'paused' ? 'Resume recording' : 'Pause recording'}>
                {snapshot.state === 'paused' ? <Play size={20} aria-hidden="true" /> : <Pause size={20} aria-hidden="true" />}
              </button>
              <span>{snapshot.state === 'paused' ? 'Resume' : 'Pause'}</span>
            </div>
            <div className="control">
              <button type="button" className={`record-button${active ? ' is-active' : ''}`} onClick={() => void toggle()} disabled={busy} aria-label={active ? 'Stop and save' : 'Start recording'}>
                {active ? <Square size={28} aria-hidden="true" fill="currentColor" /> : <Mic size={32} aria-hidden="true" />}
              </button>
              <span>{active ? 'Stop' : snapshot.state === 'starting' ? 'Starting' : 'Record'}</span>
            </div>
            <div className="control">
              <button type="button" className="round-button" onClick={() => recorder.mark()} disabled={!active} aria-label="Mark this moment">
                <Bookmark size={20} aria-hidden="true" />
              </button>
              <span>Mark</span>
            </div>
          </div>

          <p className={`timer-message${snapshot.error || snapshot.warning ? ' is-alert' : ''}`} role="status" aria-live="polite">{message}</p>
          {!connected && snapshot.state === 'idle' && <p className="connect-prompt"><a className="primary-button" href="#/settings?connect=1">Connect to voicebrain</a></p>}
          <p className="timer-help">Space starts and stops · M marks a moment. The screen stays on while recording.</p>
        </div>
      </section>

      <section className="recent-column" aria-labelledby="recent-title">
        <div className="list-heading">
          <h2 id="recent-title">Recent</h2>
          <a className="text-link" href="#/library">All notes</a>
        </div>
        {recent.length === 0
          ? <p className="empty">Nothing recorded yet. Your notes will appear here, with their upload status.</p>
          : <ul className="recent-list">
            {recent.map(note => <li key={note.id} className="recent-item">
              <span className="note-title">{note.title || defaultTitle(note.createdAt)}</span>
              <span className="note-meta">{clockTime(note.createdAt)} · {formatDuration(note.durationMs)}</span>
              <StatusLabel view={describeStatus(note, settings, now, online)} />
            </li>)}
          </ul>}
      </section>
    </div>
  </main>
}
