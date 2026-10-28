import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SettingsContext, ToastContext, type ToastOptions } from './contexts'
import { loadSettings, patchSettings } from './settings'
import type { Settings } from './types'

/** Loads settings from IndexedDB before the app renders, so the first screen already knows the connection. */
export function SettingsProvider({ children }: { children: (settings: Settings) => ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => { void loadSettings().then(setSettings) }, [])

  const update = useCallback(async (patch: Partial<Settings>) => {
    const saved = await patchSettings(patch)
    setSettings(saved)
    return saved
  }, [])

  const value = useMemo(() => (settings ? { settings, update } : null), [settings, update])
  if (!value) return null
  return <SettingsContext.Provider value={value}>{children(value.settings)}</SettingsContext.Provider>
}

interface ToastState extends ToastOptions { key: string; message: string }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const show = useCallback((message: string, options: ToastOptions = {}) => {
    clearTimeout(timer.current)
    setToast({ key: `${Date.now()}-${Math.random()}`, message, ...options })
    timer.current = setTimeout(() => setToast(null), options.durationMs ?? 5000)
  }, [])

  return <ToastContext.Provider value={show}>
    {children}
    <div className="toast-region" role="status" aria-live="polite">
      {toast && <div className="toast" key={toast.key}>
        <span>{toast.message}</span>
        {toast.actionLabel && <button type="button" onClick={() => { toast.onAction?.(); setToast(null) }}>{toast.actionLabel}</button>}
      </div>}
    </div>
  </ToastContext.Provider>
}
