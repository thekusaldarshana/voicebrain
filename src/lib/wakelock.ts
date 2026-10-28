/** Keeps the screen on while recording, because most phones stop the microphone once the page is hidden. */
export class ScreenLock {
  private sentinel: WakeLockSentinel | null = null
  private wanted = false

  private readonly onVisible = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.acquire()
  }

  async hold(): Promise<void> {
    this.wanted = true
    document.addEventListener('visibilitychange', this.onVisible)
    await this.acquire()
  }

  async release(): Promise<void> {
    this.wanted = false
    document.removeEventListener('visibilitychange', this.onVisible)
    const sentinel = this.sentinel
    this.sentinel = null
    try { await sentinel?.release() } catch { /* already released */ }
  }

  private async acquire(): Promise<void> {
    try {
      if (!('wakeLock' in navigator) || this.sentinel) return
      this.sentinel = await navigator.wakeLock.request('screen')
      this.sentinel.addEventListener('release', () => { this.sentinel = null })
    } catch {
      // Denied (low battery, unsupported). Recording still works.
    }
  }
}
