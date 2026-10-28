import { describe, expect, it } from 'vitest'
import { clockTime, dayHeading, dayKey, defaultTitle, formatBytes, formatClock, formatDuration, formatUntil, parseTags } from '../src/lib/format'

describe('formatting', () => {
  it('formats the live session as 00:00:00', () => {
    expect(formatClock(0)).toBe('00:00:00')
    expect(formatClock(61_999)).toBe('00:01:01')
    expect(formatClock(3_725_000)).toBe('01:02:05')
    expect(formatClock(-5)).toBe('00:00:00')
  })
  it('formats durations for lists', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(134_000)).toBe('2m 14s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
  })
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1_500_000)).toBe('1.4 MB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
  })
  it('names days relative to today', () => {
    const today = new Date(2026, 9, 28, 12).getTime()
    expect(dayHeading(dayKey(today), dayKey(today))).toBe('Today')
    expect(dayHeading(dayKey(new Date(2026, 9, 27, 9).getTime()), dayKey(today))).toBe('Yesterday')
    expect(dayHeading('2026-10-20', dayKey(today))).toMatch(/20 October/)
  })
  it('titles untitled notes by time', () => {
    const at = new Date(2026, 9, 28, 14, 5).getTime()
    expect(clockTime(at)).toBe('14:05')
    expect(defaultTitle(at)).toBe('Voice note · 14:05')
  })
  it('formats retry waits', () => {
    expect(formatUntil(40_000)).toBe('40s')
    expect(formatUntil(5 * 60_000)).toBe('5m')
    expect(formatUntil(3 * 3600_000)).toBe('3h')
  })
  it('cleans tags', () => {
    expect(parseTags('Idea, #Work,  big plan ,idea,,')).toEqual(['idea', 'work', 'big-plan'])
    expect(parseTags('')).toEqual([])
  })
})
