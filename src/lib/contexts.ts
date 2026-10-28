import { createContext } from 'react'
import type { Settings } from './types'

export interface SettingsValue { settings: Settings; update: (patch: Partial<Settings>) => Promise<Settings> }
export const SettingsContext = createContext<SettingsValue | null>(null)

export interface ToastOptions { actionLabel?: string; onAction?: () => void; durationMs?: number }
export const ToastContext = createContext<(message: string, options?: ToastOptions) => void>(() => undefined)
