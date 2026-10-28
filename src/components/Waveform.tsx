import { useEffect, useRef } from 'react'
import { LEVEL_BARS, recorder, type RecorderState } from '../lib/recorder'

/** Live input level as a row of bars. A text status sits next to it, so the picture is only supplementary. */
export function Waveform({ state }: { state: RecorderState }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const style = getComputedStyle(element)
    const active = style.getPropertyValue('--color-text-secondary').trim() || '#b5b5b5'
    const idle = style.getPropertyValue('--color-surface-raised').trim() || '#262626'
    let frame = 0

    const draw = () => {
      const ratio = window.devicePixelRatio || 1
      const width = element.clientWidth
      const height = element.clientHeight
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio)
        element.height = Math.round(height * ratio)
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      const levels = recorder.getLevels()
      const slot = width / LEVEL_BARS
      const barWidth = Math.max(2, slot * 0.55)
      const live = state === 'recording'
      for (let index = 0; index < LEVEL_BARS; index += 1) {
        const level = live || state === 'paused' ? levels[index] : 0
        const barHeight = Math.max(3, level * height)
        context.fillStyle = level > 0.02 && live ? active : idle
        context.beginPath()
        context.roundRect(index * slot + (slot - barWidth) / 2, (height - barHeight) / 2, barWidth, barHeight, barWidth / 2)
        context.fill()
      }
      if (live) frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [state])

  return <canvas ref={canvas} className="waveform" aria-hidden="true" />
}
