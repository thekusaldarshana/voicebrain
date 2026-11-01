import { useSettings, useSignOut } from '../lib/hooks'

export type Page = 'record' | 'library' | 'settings'

const items: { page: Page; label: string }[] = [
  { page: 'record', label: 'Record' },
  { page: 'library', label: 'Library' },
  { page: 'settings', label: 'Settings' },
]

/** Same top bar as Trapper: ringed brand mark and pill navigation. */
export function TopNav({ current, waiting }: { current: Page; waiting: number }) {
  const { settings } = useSettings()
  const signOut = useSignOut()
  const signedIn = Boolean(settings.endpoint && settings.token)
  return <header className="topbar"><div className="shell topbar-inner">
    <a className="brand" href="#/record" aria-label="voicebrain, record"><span className="brand-mark" aria-hidden="true">V</span><span>voicebrain</span></a>
    <nav className="top-nav" aria-label="Main navigation">
      {items.map(item => <a key={item.page} className="nav-link" href={`#/${item.page}`} aria-current={item.page === current ? 'page' : undefined}>
        {item.label}
        {item.page === 'library' && waiting > 0 && <span className="nav-count" aria-label={`${waiting} waiting to upload`}>{waiting}</span>}
      </a>)}
      {signedIn
        ? <button type="button" className="nav-link nav-action" onClick={() => void signOut()}>Sign out</button>
        : <a className="nav-link nav-action" href="#/settings?connect=1">Sign in</a>}
    </nav>
  </div></header>
}
