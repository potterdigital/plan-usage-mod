import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { PlanUsageLimit, PlanUsagePause, PlanUsageReading } from '../types'
import {
  ORANGE,
  RESUME_DELAY_MS,
  describeLimits,
  formatIn,
  isReading,
  labelOf,
  lookOf,
  pauseTrigger,
  resetsAtMs,
  resolveZone,
  timeFormat,
} from './usage'
import type { TimeFormat } from './usage'

// $.state carries the figures to the band and across a hot reload. Every $.state read within one event
// sees a single moment, so a timer or a long tool call would read stale values: the module variables
// below are what the logic trusts, and each change is written through to $.state.
const READING = { plugin: 'plan-usage', key: 'reading' } as const
const PAUSE = { plugin: 'plan-usage', key: 'pause' } as const

const TOOL = 'mcp__plan-usage__plan_usage'
// How often an idle session looks for a newer reading another session stored. A local file read.
const SYNC_MS = 60_000
// Redraws the band so "resets in" counts down.
const TICK_MS = 30_000
const STALE_MS = 5 * 60_000
const BAND_KINDS = ['five_hour', 'seven_day']

let warnAt = 80
let autoPause = false
let threshold = 95
let resumePrompt = ''
let time: TimeFormat = timeFormat('UTC')
let zoneWarning = ''

let latest: PlanUsageReading | null = null
let held: PlanUsagePause | null = null
// The main turn now running, kept for $.turn.abort; null between turns.
let turnId: string | null = null
let toolsRunning = 0
// Set when the pause refused a tool call: the turn was cut short even if it then ended by itself.
let wasRefused = false
let resumeTimer: Timer | null = null

async function setReading($: EngineInterface, next: PlanUsageReading | null): Promise<void> {
  latest = next
  await $.state.set(READING, next)
}

async function setPause($: EngineInterface, next: PlanUsagePause | null): Promise<void> {
  held = next
  await $.state.set(PAUSE, next)
}

// Plan limits are per login, and every profile (CLAUDE_CONFIG_DIR) shares one $.store file.
async function sharedKey($: EngineInterface): Promise<string> {
  return `reading:${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? 'default'}`
}

// Keeps whichever reading is newer, then checks the pause threshold.
async function adopt($: EngineInterface, next: PlanUsageReading): Promise<void> {
  if (next.limits.length === 0) return
  if (latest !== null && latest.readAt > next.readAt) return
  await setReading($, next)
  await checkPause($)
}

// A reply's figures, also stored so idle sessions on the same login see them.
async function fromReply($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<void> {
  const now = await $.clock.now()
  const copied: PlanUsageLimit[] = limits.map(({ kind, percentUsed, resetsAt }) =>
    resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt },
  )
  const reply: PlanUsageReading = { limits: copied, readAt: now }
  await adopt($, reply)
  await $.store.set(await sharedKey($), reply)
}

async function fromShared($: EngineInterface): Promise<void> {
  const stored = await $.store.get(await sharedKey($))
  if (isReading(stored)) await adopt($, stored)
}

async function checkPause($: EngineInterface): Promise<void> {
  if (!autoPause || turnId === null || held !== null || latest === null) return
  const hit = pauseTrigger(latest.limits, threshold)
  if (hit === undefined) return
  const resetsAt = resetsAtMs(hit)
  if (resetsAt === undefined) {
    $.ui.log(`session limit at ${hit.percentUsed}% but Claude Code reported no reset time, so no pause`)
    return
  }
  // A reading from a window that has since reset says nothing about the current one.
  if (resetsAt <= (await $.clock.now())) return
  await setPause($, { phase: 'pending', percentUsed: hit.percentUsed, resumeAt: resetsAt + RESUME_DELAY_MS })
  $.ui.toast(`Session limit at ${hit.percentUsed}%: pausing after the running tool call`)
  if (toolsRunning === 0) await stopTurn($)
}

// Ends the running turn and waits for the reset.
async function stopTurn($: EngineInterface): Promise<void> {
  if (held === null || held.phase !== 'pending') return
  const stopping = turnId
  turnId = null
  await setPause($, { ...held, phase: 'waiting' })
  if (stopping !== null) {
    try {
      await $.turn.abort({ turnId: stopping })
    } catch (error) {
      $.ui.log(`could not stop the turn: ${String(error)}`, { to: 'debug' })
    }
  }
  const now = await $.clock.now()
  $.ui.log(`paused at ${held.percentUsed}% of the session limit; continuing at ${time.at(held.resumeAt, now)}`)
  await armResume($)
}

async function armResume($: EngineInterface): Promise<void> {
  if (held === null || held.phase !== 'waiting') return
  resumeTimer?.cancel()
  const wait = Math.max(0, held.resumeAt - (await $.clock.now()))
  resumeTimer = $.clock.after(wait, () => {
    void resume($)
  })
}

// At the reset plus 2 minutes: if a newer reading moved the reset later, wait again; else continue.
async function resume($: EngineInterface): Promise<void> {
  resumeTimer = null
  await fromShared($)
  const still = latest === null ? undefined : pauseTrigger(latest.limits, threshold)
  const movedTo = still === undefined ? undefined : resetsAtMs(still)
  if (held !== null && movedTo !== undefined && movedTo + RESUME_DELAY_MS > held.resumeAt) {
    await setPause($, { ...held, resumeAt: movedTo + RESUME_DELAY_MS })
    await armResume($)
    return
  }
  await setPause($, null)
  wasRefused = false
  await $.prompt.submit({ text: resumePrompt })
}

async function report($: EngineInterface): Promise<string> {
  const usage = await $.session.usage()
  if (usage.rateLimits.length > 0) await fromReply($, usage.rateLimits)
  else await fromShared($)
  const now = await $.clock.now()
  const pause = held === null ? null : { ...held, resumeAtLocal: time.at(held.resumeAt, now) }
  return JSON.stringify(
    {
      limits: latest === null ? [] : describeLimits(latest.limits, now, time, warnAt),
      readAtLocal: latest === null ? null : time.at(latest.readAt, now),
      timeZone: time.zone,
      autoPause: { isOn: autoPause, threshold, pause },
      ...(latest === null
        ? { note: 'No reading yet: Claude Code reports plan limits with model replies on a claude.ai plan.' }
        : {}),
    },
    null,
    2,
  )
}

export const register: Register = (on, options) => {
  warnAt = typeof options.warn_at === 'number' ? options.warn_at : 80
  autoPause = options.auto_pause === true
  threshold = typeof options.pause_threshold === 'number' ? options.pause_threshold : 95
  resumePrompt =
    typeof options.resume_prompt === 'string' && options.resume_prompt.trim() !== ''
      ? options.resume_prompt
      : 'Plan usage reset; resume where you left off from the files on disk.'
  const configured = typeof options.time_zone === 'string' ? options.time_zone : ''
  const resolved = resolveZone(configured)
  time = timeFormat(resolved.zone)
  zoneWarning = resolved.isFallback ? `time_zone "${configured}" is not a time zone; showing ${resolved.zone}` : ''

  on('session.start', async ($, e, next) => {
    // After a hot reload, pick up what the previous copy of this module held.
    latest = (await $.state.get(READING)).value ?? null
    held = (await $.state.get(PAUSE)).value ?? null
    if (zoneWarning !== '') $.ui.log(zoneWarning)
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) await fromReply($, usage.rateLimits)
    else await fromShared($)
    $.clock.every(SYNC_MS, () => {
      void fromShared($)
    })
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    await armResume($)
    await $.tool.register({
      name: 'plan_usage',
      description:
        "The Claude plan's usage limits right now, at no token cost: one entry per window, with kind (five_hour is the session limit, seven_day the weekly one), percentUsed from 0 to 100, resetsAt as ISO 8601 and resetsAtLocal in the user's time zone. Check it before starting long or unattended work.",
      inputSchema: { type: 'object', properties: {} },
    })
    try {
      await $.command.register({ name: 'plan-usage', description: 'Show plan usage limits and reset times', immediate: true })
    } catch (error) {
      $.ui.log(`/plan-usage not registered: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state and start a different conversation: drop any pending continue.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    resumeTimer?.cancel()
    resumeTimer = null
    turnId = null
    held = null
    wasRefused = false
    if (latest !== null) await $.state.set(READING, latest)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await fromReply($, e.rateLimits)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // Subagent turns start inside the main one; keep the main turn's id.
    if (turnId === null) turnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnId = null
      if (held !== null && held.phase === 'pending') {
        if (wasRefused) {
          // The pause refused a tool call, so the work stopped early: continue it after the reset.
          await setPause($, { ...held, phase: 'waiting' })
          await armResume($)
        } else {
          // The turn finished on its own before anything was cut: nothing to continue.
          await setPause($, null)
        }
      }
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async $ => ({ result: await report($) }))

  on('tool.call', async ($, e, next) => {
    if (held !== null) {
      wasRefused = true
      return {
        deny: `Paused: the plan's session limit is at ${held.percentUsed}%. Stop here; the session continues after the limit resets.`,
      }
    }
    toolsRunning += 1
    try {
      return await next(e)
    } finally {
      toolsRunning -= 1
      if (toolsRunning === 0) await stopTurn($)
    }
  })

  on('command.run', { command: 'plan-usage' }, async $ => ({ text: await report($) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = (await $.state.get(READING)).value ?? null
    const pausing = (await $.state.get(PAUSE)).value ?? null
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const isNarrow = e.props.bodyColumns < 100
    // The band is shared: keep what the mods after this one draw (Claude Code's own notes included) under this line.
    const theirs = await next(e)

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">◌ Plan usage: no reading yet (it appears after the first reply)</Text>
          {theirs}
        </Box>
      )
    }

    const shown = BAND_KINDS.flatMap(kind => current.limits.filter(limit => limit.kind === kind))
    const isStale = now - current.readAt > STALE_MS

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={3}>
          {pausing === null ? null : (
            <Text color={ORANGE} bold wrap="truncate-end">
              ⏸ PAUSED at {pausing.percentUsed}% · continues {time.at(pausing.resumeAt, now)}
            </Text>
          )}
          {shown.map(limit => {
            const look = lookOf(limit.percentUsed, warnAt)
            const at = resetsAtMs(limit)
            const resets =
              at === undefined
                ? ''
                : isNarrow
                  ? ` · ${formatIn(at - now)}`
                  : ` · resets ${time.at(at, now)} (${formatIn(at - now)})`
            return (
              <Box key={limit.kind} flexDirection="row" columnGap={1}>
                <Text color={look.color} bold>
                  {look.icon} {look.word}
                </Text>
                <Text wrap="truncate-end">
                  {labelOf(limit.kind)} {limit.percentUsed}%{resets}
                </Text>
              </Box>
            )
          })}
          {isStale ? <Text wrap="truncate-end">as of {time.at(current.readAt, now)}</Text> : null}
        </Box>
        {theirs}
      </Box>
    )
  })
}
