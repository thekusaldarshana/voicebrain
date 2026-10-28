/** Tells every open page (and the service worker) that stored notes changed. */
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('trapper-voice')
const local = new EventTarget()

export function notifyChanged(): void {
  channel?.postMessage({ type: 'changed' })
  local.dispatchEvent(new Event('changed'))
}

export function onChanged(callback: () => void): () => void {
  local.addEventListener('changed', callback)
  channel?.addEventListener('message', callback)
  return () => {
    local.removeEventListener('changed', callback)
    channel?.removeEventListener('message', callback)
  }
}
