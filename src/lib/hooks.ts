import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { listNotes } from './db'
import { onChanged } from './changes'
import { SettingsContext, ToastContext, type SettingsValue } from './contexts'
import { recorder, type RecorderSnapshot } from './recorder'
import { removeNote } from './notes'
import type { Note } from './types'

export function useRecorder(): RecorderSnapshot {
  return useSyncExternalStore(recorder.subscribe, recorder.getSnapshot)
}

/** Notes waiting for their Undo window to close. They are hidden but not yet deleted. */
const pendingDeletes = new Set<string>()
const pendingListeners = new Set<() => void>()
const emitPending = () => pendingListeners.forEach(listener => listener())

/** Hides a note now and deletes it after 7 seconds. The returned function is Undo. */
export function scheduleDelete(id: string): () => void {
  pendingDeletes.add(id)
  emitPending()
  const timer = setTimeout(() => {
    void removeNote(id).finally(() => { pendingDeletes.delete(id); emitPending() })
  }, 7000)
  return () => {
    clearTimeout(timer)
    pendingDeletes.delete(id)
    emitPending()
  }
}

export function useNotes(): { notes: Note[]; ready: boolean } {
  const [all, setAll] = useState<Note[]>([])
  const [ready, setReady] = useState(false)
  const [, setTick] = useState(0)
  const reload = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(() => {
    void listNotes().then(notes => { setAll(notes); setReady(true) }).catch(() => setReady(true))
  }, [])

  useEffect(() => {
    load()
    const stop = onChanged(() => { clearTimeout(reload.current); reload.current = setTimeout(load, 80) })
    const bump = () => setTick(value => value + 1)
    pendingListeners.add(bump)
    return () => { stop(); pendingListeners.delete(bump); clearTimeout(reload.current) }
  }, [load])

  return { notes: all.filter(note => !pendingDeletes.has(note.id)), ready }
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    callback => {
      window.addEventListener('online', callback)
      window.addEventListener('offline', callback)
      return () => { window.removeEventListener('online', callback); window.removeEventListener('offline', callback) }
    },
    () => navigator.onLine,
  )
}

/** Re-renders on an interval so relative times such as "retry in 40s" stay current. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('useSettings outside SettingsProvider')
  return value
}

export function useToast() { return useContext(ToastContext) }
