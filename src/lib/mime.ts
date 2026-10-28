const CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

export function pickMime(isSupported: (mime: string) => boolean = mime => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)): string {
  return CANDIDATES.find(isSupported) ?? ''
}

export function extensionFor(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  if (base === 'audio/webm') return 'webm'
  if (base === 'audio/mp4' || base === 'audio/x-m4a' || base === 'audio/m4a') return 'm4a'
  if (base === 'audio/ogg') return 'ogg'
  if (base === 'audio/mpeg') return 'mp3'
  if (base === 'audio/wav' || base === 'audio/x-wav') return 'wav'
  if (base === 'audio/aac') return 'aac'
  if (base === 'audio/flac') return 'flac'
  return 'bin'
}
