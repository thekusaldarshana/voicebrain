export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function micErrorMessage(error: unknown): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Recording needs a secure page. Open the app over https:// (or localhost).'
  }
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Check that one is connected, or pick another in Settings.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy or unavailable. Close other apps that may be using it and try again.'
  return `The microphone could not start. ${errorMessage(error)}`
}
