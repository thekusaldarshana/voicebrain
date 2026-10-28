import { useEffect, useState } from 'react'
import { useNotes, useSettings, useToast } from '../lib/hooks'
import { isConfigured, isPrivateAddress, normalizeEndpoint } from '../lib/endpoint'
import { formatBytes } from '../lib/format'
import { retryFailed } from '../lib/notes'
import { kickUploads, pingServer } from '../lib/uploader'
import type { Settings } from '../lib/types'

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle">
    <span><span className="toggle-label">{label}</span>{hint && <span className="hint">{hint}</span>}</span>
    <input type="checkbox" role="switch" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="toggle-track" aria-hidden="true"><span /></span>
  </label>
}

export function SettingsPage({ installPrompt }: { installPrompt: InstallEvent | null }) {
  const { settings, update } = useSettings()
  const { notes } = useNotes()
  const toast = useToast()
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState<string | null>(null)
  const endpoint = endpointDraft ?? settings.endpoint
  const token = tokenDraft ?? settings.token
  const [showToken, setShowToken] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)

  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices().then(list => setDevices(list.filter(device => device.kind === 'audioinput'))).catch(() => undefined)
    void navigator.storage?.estimate().then(estimate => setStorage({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 })).catch(() => undefined)
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => undefined)
  }, [notes.length])

  const dirty = endpoint !== settings.endpoint || token !== settings.token
  const set = (patch: Partial<Settings>) => void update(patch)

  const saveConnection = async () => {
    await update({ endpoint, token })
    setEndpointDraft(null)
    setTokenDraft(null)
    const revived = await retryFailed()
    kickUploads({ force: false, ignoreBackoff: true })
    toast(revived ? `Saved. Retrying ${revived} ${revived === 1 ? 'note' : 'notes'}.` : 'Connection saved.')
  }

  const test = async () => {
    setTesting(true); setResult(null)
    setResult(await pingServer({ endpoint, token }))
    setTesting(false)
  }

  const waiting = notes.filter(note => note.status === 'local' || note.status === 'uploading').length
  const audioBytes = notes.filter(note => !note.audioRemoved).reduce((sum, note) => sum + note.size, 0)

  return <main className="page settings-page">
    <div className="shell narrow">
      <p className="eyebrow">This device</p>
      <h1>Settings</h1>

      <section className="settings-section" aria-labelledby="connection-title">
        <h2 id="connection-title">Connection</h2>
        <p className="hint">Where recordings are sent. You can also open a pairing link from your server and this fills in on its own.</p>
        <label className="field">
          <span className="field-label">Server address</span>
          <input value={endpoint} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://notes.example.com" onChange={event => { setEndpointDraft(event.target.value); setResult(null) }} />
        </label>
        <label className="field">
          <span className="field-label">Access token</span>
          <span className="input-row">
            <input value={token} type={showToken ? 'text' : 'password'} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={event => { setTokenDraft(event.target.value); setResult(null) }} />
            <button type="button" className="secondary-button" onClick={() => setShowToken(value => !value)} aria-pressed={showToken}>{showToken ? 'Hide' : 'Show'}</button>
          </span>
        </label>
        {endpoint && !token && <p className="hint warn">No token set. Anyone who finds this address could send notes to it.</p>}
        {endpoint && normalizeEndpoint(endpoint).startsWith('http://') && !isPrivateAddress(endpoint) && <p className="hint warn">This address is not encrypted. Use https:// for anything outside your own network.</p>}
        <label className="field">
          <span className="field-label">This device’s name</span>
          <input value={settings.deviceName} maxLength={40} onChange={event => set({ deviceName: event.target.value })} />
        </label>
        <div className="row-actions">
          <button type="button" className="primary-button" onClick={() => void saveConnection()} disabled={!dirty}>Save</button>
          <button type="button" className="secondary-button" onClick={() => void test()} disabled={testing || !endpoint}>{testing ? 'Testing…' : 'Test connection'}</button>
        </div>
        {result && <p className={`test-result ${result.ok ? 'ok' : 'bad'}`} role="status">{result.message}</p>}
      </section>

      <section className="settings-section" aria-labelledby="upload-title">
        <h2 id="upload-title">Uploads</h2>
        <Toggle label="Upload automatically" hint="Starts the moment a recording is saved, and again whenever the connection returns." checked={settings.autoUpload} onChange={value => { set({ autoUpload: value }); if (value) kickUploads({ ignoreBackoff: true }) }} />
        <label className="field">
          <span className="field-label">Keep audio on this device after upload</span>
          <select value={settings.keepAfterUpload} onChange={event => set({ keepAfterUpload: Number(event.target.value) })}>
            <option value={0}>Remove right away</option>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={-1}>Keep forever</option>
          </select>
        </label>
        <div className="row-actions">
          <button type="button" className="secondary-button" onClick={() => { kickUploads({ force: true, ignoreBackoff: true }); toast(waiting ? `Uploading ${waiting} ${waiting === 1 ? 'note' : 'notes'}…` : 'Nothing is waiting.') }} disabled={!isConfigured(settings)}>Upload waiting notes now</button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="recording-title">
        <h2 id="recording-title">Recording</h2>
        <label className="field">
          <span className="field-label">Quality</span>
          <select value={settings.bitrate} onChange={event => set({ bitrate: Number(event.target.value) })}>
            <option value={24000}>Small · 24 kbps (about 11 MB an hour)</option>
            <option value={32000}>Speech · 32 kbps (about 14 MB an hour)</option>
            <option value={64000}>Clear · 64 kbps (about 29 MB an hour)</option>
            <option value={128000}>High · 128 kbps (about 58 MB an hour)</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Microphone</span>
          <select value={settings.inputDeviceId} onChange={event => set({ inputDeviceId: event.target.value })}>
            <option value="">Default</option>
            {devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
          </select>
          {devices.length > 0 && devices.every(device => !device.label) && <span className="hint">Names appear after the first recording grants microphone access.</span>}
        </label>
        <Toggle label="Reduce background noise" checked={settings.noiseSuppression} onChange={value => set({ noiseSuppression: value })} />
        <Toggle label="Even out volume" hint="Automatic gain control." checked={settings.autoGainControl} onChange={value => set({ autoGainControl: value })} />
        <Toggle label="Cancel echo" hint="Helpful on speakerphone, can clip quiet speech." checked={settings.echoCancellation} onChange={value => set({ echoCancellation: value })} />
        <Toggle label="Start recording when the app opens" hint="The Record shortcut on your home screen always does this." checked={settings.recordOnOpen} onChange={value => set({ recordOnOpen: value })} />
      </section>

      <section className="settings-section" aria-labelledby="storage-title">
        <h2 id="storage-title">Storage</h2>
        <dl className="facts">
          <div><dt>Notes on this device</dt><dd>{notes.filter(note => note.status !== 'recording').length}</dd></div>
          <div><dt>Waiting to upload</dt><dd>{waiting}</dd></div>
          <div><dt>Audio stored</dt><dd>{formatBytes(audioBytes)}</dd></div>
          {storage && storage.quota > 0 && <div><dt>Browser storage used</dt><dd>{formatBytes(storage.usage)} of {formatBytes(storage.quota)}</dd></div>}
        </dl>
        {persisted === false && <>
          <p className="hint">The browser may clear this device’s data when space is low. Ask it to keep your notes until they are uploaded.</p>
          <div className="row-actions"><button type="button" className="secondary-button" onClick={async () => { const granted = await navigator.storage.persist(); setPersisted(granted); toast(granted ? 'Storage will be kept.' : 'The browser declined. Installing the app usually helps.') }}>Keep my data</button></div>
        </>}
        {persisted === true && <p className="hint">Storage is protected from automatic clearing.</p>}
      </section>

      <section className="settings-section" aria-labelledby="install-title">
        <h2 id="install-title">Install</h2>
        {window.matchMedia('(display-mode: standalone)').matches
          ? <p className="hint">Installed. Press and hold the app icon for the Record shortcut.</p>
          : installPrompt
            ? <><p className="hint">Add Trapper Voice to your home screen to open it like an app, offline, with a one-tap Record shortcut.</p>
              <div className="row-actions"><button type="button" className="primary-button" onClick={() => void installPrompt.prompt()}>Install app</button></div></>
            : <p className="hint">In your browser menu choose “Install app” or “Add to Home screen”. On iPhone use Share, then Add to Home Screen.</p>}
      </section>
    </div>
  </main>
}
