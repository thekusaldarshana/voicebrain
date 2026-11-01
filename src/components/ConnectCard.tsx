import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react'
import { connectDevice, type ConnectState } from '../lib/connect'
import { DEFAULT_SERVER } from '../lib/defaults'
import { normalizeEndpoint } from '../lib/endpoint'
import { useSettings, useToast } from '../lib/hooks'
import { disconnectThisDevice } from '../lib/server'
import { kickUploads, pingServer } from '../lib/uploader'

const host = (endpoint: string) => { try { return new URL(endpoint).host } catch { return endpoint } }
const minutes = (ms: number) => `${Math.floor(Math.max(0, ms) / 60_000)}:${String(Math.floor((Math.max(0, ms) % 60_000) / 1000)).padStart(2, '0')}`

/**
 * One tap to connect. The app asks the server for a code, opens the server's approval page, and waits.
 * The person's only part is the passphrase, once, on that page: the one thing that has to be typed by a human.
 */
export function ConnectCard({ autoStart = false }: { autoStart?: boolean }) {
  const { settings, update } = useSettings()
  const toast = useToast()
  const [state, setState] = useState<ConnectState>({ phase: 'idle' })
  const [server, setServer] = useState(DEFAULT_SERVER)
  const [changing, setChanging] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const connected = Boolean(settings.endpoint && settings.token)

  useEffect(() => {
    if (state.phase !== 'waiting') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state.phase])

  useEffect(() => () => abort.current?.abort(), [])

  const start = useCallback(async (popup: Window | null) => {
    const endpoint = normalizeEndpoint(server)
    if (!endpoint) { setState({ phase: 'failed', reason: 'network', message: 'Enter the server address first.' }); popup?.close(); return }
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    let opened = false
    const connectedWith = await connectDevice(endpoint, settings.deviceName, next => {
      setState(next)
      if (next.phase === 'waiting' && popup && !opened) { opened = true; popup.location.href = next.url }
      if (next.phase === 'failed') popup?.close()
    }, controller.signal)
    if (!connectedWith) { if (controller.signal.aborted) popup?.close(); return }
    popup?.close()
    await update({ endpoint: connectedWith.endpoint, token: connectedWith.token, deviceId: connectedWith.deviceId })
    setState({ phase: 'idle' })
    kickUploads({ ignoreBackoff: true })
    toast('Connected. Notes will upload on their own.')
  }, [server, settings.deviceName, toast, update])

  // Opening the page in a blank window we already hold is allowed by the browser because it happens inside the tap.
  const tap = () => { void start(window.open('', '_blank')) }

  useEffect(() => {
    if (autoStart && !connected && state.phase === 'idle') void start(null)
    // Only once, when Settings was opened with "connect me" already asked for.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])

  const cancel = () => { abort.current?.abort(); setState({ phase: 'idle' }) }

  const disconnect = async () => {
    await disconnectThisDevice(settings)
    await update({ token: '', deviceId: '' })
    setTest(null)
    toast('This device is disconnected. Recordings stay on it until you connect again.')
  }

  if (connected) {
    return <div className="connect">
      <p className="connect-status"><Check size={16} aria-hidden="true" /><span><strong>Connected</strong> to {host(settings.endpoint)} as “{settings.deviceName}”.</span></p>
      <div className="row-actions">
        <button type="button" className="secondary-button" onClick={async () => setTest(await pingServer(settings))}>Test connection</button>
        <button type="button" className="secondary-button danger" onClick={() => void disconnect()}>Disconnect this device</button>
      </div>
      {test && <p className={`test-result ${test.ok ? 'ok' : 'bad'}`} role="status">{test.message}</p>}
    </div>
  }

  if (state.phase === 'waiting') {
    return <div className="connect" aria-live="polite">
      <p className="hint">Your server’s page opened. Check it shows this code, type your passphrase, and tap Approve. This screen connects by itself.</p>
      <p className="connect-code" aria-label={`Pairing code ${state.code.split('').join(' ')}`}>{state.code}</p>
      <div className="row-actions">
        <a className="primary-button" href={state.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Open the approval page</a>
        <button type="button" className="secondary-button" onClick={cancel}>Cancel</button>
      </div>
      <p className="hint"><LoaderCircle size={12} className="spin" aria-hidden="true" /> Waiting for approval · the code expires in {minutes(state.expiresAt - now)}</p>
    </div>
  }

  return <div className="connect">
    <button type="button" className="primary-button big" onClick={tap} disabled={state.phase === 'starting'}>
      {state.phase === 'starting' ? 'Contacting your server…' : 'Connect to voicebrain'}
    </button>
    {state.phase === 'failed' && <p className="hint warn" role="alert"><CircleAlert size={12} aria-hidden="true" /> {state.message}</p>}
    <p className="hint">
      Your server: {changing
        ? <input className="inline-input" aria-label="Server address" value={server} inputMode="url" autoCapitalize="none" spellCheck={false} onChange={event => setServer(event.target.value)} />
        : <strong>{host(server)}</strong>}
      {' · '}<button type="button" className="link-button" onClick={() => setChanging(value => !value)}>{changing ? 'Done' : 'Use a different server'}</button>
    </p>
  </div>
}
