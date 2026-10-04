// Pure helpers: no `$`, so tests call them directly.
import type { PlanUsageLimit } from '../types'

export const RESUME_DELAY_MS = 2 * 60_000

// Blue below the warning level, orange at or above it. The icon and the word carry the level too,
// so it never rests on color alone (red/green colorblind readers included).
export const BLUE = '#4ea1ff'
export const ORANGE = '#ff9f1a'

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  spend_limit: 'Spend',
}

export type Level = 'ok' | 'high' | 'limit'

export interface LevelLook {
  icon: string
  word: string
  color: string
}

const LOOKS: Record<Level, LevelLook> = {
  ok: { icon: '●', word: 'OK', color: BLUE },
  high: { icon: '▲', word: 'HIGH', color: ORANGE },
  limit: { icon: '■', word: 'LIMIT', color: ORANGE },
}

export function labelOf(kind: string): string {
  return LABELS[kind] ?? kind
}

export function levelOf(percentUsed: number, warnAt: number): Level {
  if (percentUsed >= 100) return 'limit'
  return percentUsed >= warnAt ? 'high' : 'ok'
}

export function lookOf(percentUsed: number, warnAt: number): LevelLook {
  return LOOKS[levelOf(percentUsed, warnAt)]
}

// The zone to show times in: the configured IANA name when it is valid, else this computer's.
export function resolveZone(configured: string): { zone: string; isFallback: boolean } {
  const system = new Intl.DateTimeFormat().resolvedOptions().timeZone
  if (configured.trim() === '') return { zone: system, isFallback: false }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured })
    return { zone: configured, isFallback: false }
  } catch {
    return { zone: system, isFallback: true }
  }
}

export interface TimeFormat {
  zone: string
  // "4:10 AM CT" today, "Thu 9:00 PM CT" within six days, "Oct 12 9:00 PM CT" beyond.
  at: (time: number, now: number) => string
}

export function timeFormat(zone: string): TimeFormat {
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' })
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' })
  const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' })
  const calendarDay = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return {
    zone,
    at: (time, now) => {
      const label = `${clock.format(time)} ${zoneLabel(zone, time)}`
      if (calendarDay.format(time) === calendarDay.format(now)) return label
      return Math.abs(time - now) / 86_400_000 < 6 ? `${weekday.format(time)} ${label}` : `${monthDay.format(time)} ${label}`
    },
  }
}

// "CT" or "ET" where the zone has a short generic name; "GMT+1" style where it does not.
function zoneLabel(zone: string, time: number): string {
  const part = (style: 'shortGeneric' | 'short'): string =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style })
      .formatToParts(time)
      .find(p => p.type === 'timeZoneName')?.value ?? ''
  const generic = part('shortGeneric')
  return /^[A-Z]{2,4}$/.test(generic) ? generic : part('short')
}

// "1h 12m", "45m", "2d 3h"; "now" once due.
export function formatIn(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function resetsAtMs(limit: PlanUsageLimit): number | undefined {
  if (limit.resetsAt === undefined) return undefined
  const at = Date.parse(limit.resetsAt)
  return Number.isNaN(at) ? undefined : at
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLimit(value: unknown): value is PlanUsageLimit {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    typeof value.percentUsed === 'number' &&
    (value.resetsAt === undefined || typeof value.resetsAt === 'string')
  )
}

// A reading another session stored; $.store is shared and outlives versions of this mod, so check its shape.
export function isReading(value: unknown): value is { limits: PlanUsageLimit[]; readAt: number } {
  return isRecord(value) && Array.isArray(value.limits) && value.limits.every(isLimit) && typeof value.readAt === 'number'
}

// The session window at or past the threshold.
export function pauseTrigger(limits: readonly PlanUsageLimit[], threshold: number): PlanUsageLimit | undefined {
  return limits.find(limit => limit.kind === 'five_hour' && limit.percentUsed >= threshold)
}

export interface DescribedLimit extends PlanUsageLimit {
  label: string
  level: Level
  resetsAtLocal?: string
  resetsIn?: string
}

export function describeLimits(
  limits: readonly PlanUsageLimit[],
  now: number,
  time: TimeFormat,
  warnAt: number,
): DescribedLimit[] {
  return limits.map(limit => {
    const at = resetsAtMs(limit)
    const described: DescribedLimit = { ...limit, label: labelOf(limit.kind), level: levelOf(limit.percentUsed, warnAt) }
    if (at !== undefined) {
      described.resetsAtLocal = time.at(at, now)
      described.resetsIn = formatIn(at - now)
    }
    return described
  })
}
