import { useEffect, useState } from 'react'
import { CloudOff } from 'lucide-react'
import { TopNav, type Page } from './components/TopNav'
import { parsePairing } from './lib/endpoint'
import { useNotes, useOnline, useSettings, useToast } from './lib/hooks'
import { SettingsProvider, ToastProvider } from './lib/providers'
import { purgeUploadedAudio } from './lib/notes'
import { recoverInterrupted } from './lib/recovery'
import { kickUploads } from './lib/uploader'
import { LibraryPage } from './pages/LibraryPage'
import { RecordPage } from './pages/RecordPage'
import { SettingsPage } from './pages/SettingsPage'

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

function currentPage(): Page {
  const name = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return name === 'library' || name === 'settings' ? name : 'record'
}

function Shell() {
  const { settings, update } = useSettings()
  const { notes } = useNotes()
  const online = useOnline()
  const toast = useToast()
  const [page, setPage] = useState<Page>(currentPage)
  const [installPrompt, setInstallPrompt] = useState<InstallEvent | null>(null)

  useEffect(() => {
    const onHash = () => setPage(currentPage())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // A pairing link from the server fills in the connection, then removes itself from the address bar.
  useEffect(() => {
    const applyPairing = () => {
      const pairing = parsePairing(window.location.hash)
      if (!pairing) return
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/settings`)
      setPage('settings')
      void update({ endpoint: pairing.endpoint, token: pairing.token, ...(pairing.deviceName ? { deviceName: pairing.deviceName } : {}) }).then(() => {
        toast('Paired. Use “Test connection” to check it.')
        kickUploads({ ignoreBackoff: true })
      })
    }
    applyPairing() // the link opened this page
    window.addEventListener('hashchange', applyPairing) // the link was opened while the app was already running
    return () => window.removeEventListener('hashchange', applyPairing)
  }, [update, toast])

  // Boot: rebuild interrupted recordings, tidy old audio, then send whatever is waiting.
  useEffect(() => {
    void (async () => {
      const recovered = await recoverInterrupted().catch(() => 0)
      if (recovered) toast(`Recovered ${recovered} unfinished ${recovered === 1 ? 'recording' : 'recordings'} from earlier.`, { durationMs: 8000 })
      await purgeUploadedAudio(settings.keepAfterUpload).catch(() => 0)
      kickUploads({ ignoreBackoff: true })
    })()
    // Runs once per launch on purpose.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])

  useEffect(() => {
    const retry = () => kickUploads({ ignoreBackoff: true })
    const onVisible = () => { if (document.visibilityState === 'visible') retry() }
    window.addEventListener('online', retry)
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener('online', retry); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  useEffect(() => {
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallEvent) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  const waiting = notes.filter(note => note.status === 'local' || note.status === 'uploading').length

  return <>
    <TopNav current={page} waiting={waiting} />
    {!online && <div className="offline-strip" role="status"><CloudOff size={14} aria-hidden="true" />You’re offline. Notes are saved on this device and upload when you’re back.</div>}
    {page === 'record' && <RecordPage />}
    {page === 'library' && <LibraryPage />}
    {page === 'settings' && <SettingsPage installPrompt={installPrompt} />}
  </>
}

export default function App() {
  return <ToastProvider><SettingsProvider>{() => <Shell />}</SettingsProvider></ToastProvider>
}
