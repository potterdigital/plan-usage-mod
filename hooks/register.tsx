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
// A person sent a prompt during a pause: no pausing again until this session window resets.
let overrideUntil = 0
let resumeTimer: Timer | null = null

async function setReading($: EngineInterface, next: PlanUsageReading | null): Promise<void> {
  latest = next
  await $.state.set(READING, next)
}

async function setPause($: EngineInterface, next: PlanUsagePause | null): Promise<void> {
  held = next
  await $.state.set(PAUSE, next)
}

// Plan limits are per login. The store file is per configuration directory, but a machine can point several
// CLAUDE_CONFIG_DIRs at one plugins folder, so the key keeps their readings apart.
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

function copyLimits(limits: readonly SessionRateLimit[]): PlanUsageLimit[] {
  return limits.map(({ kind, percentUsed, resetsAt }) =>
    resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt },
  )
}

// A model reply's figures, as session.measure delivers them: stamped now, and stored so idle sessions on the
// same login see them.
async function fromReply($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<void> {
  const reply: PlanUsageReading = { limits: copyLimits(limits), readAt: await $.clock.now() }
  await adopt($, reply)
  await $.store.set(await sharedKey($), reply)
}

async function fromShared($: EngineInterface): Promise<void> {
  const stored = await $.store.get(await sharedKey($))
  if (isReading(stored)) await adopt($, stored)
}

// The figures of this session's last reply when nothing better is known. They may be old, so they are never
// stored for other sessions and are dated as far back as they could be: the start of this session.
async function fromLastReply($: EngineInterface): Promise<void> {
  if (latest !== null) return
  const usage = await $.session.usage()
  if (usage.rateLimits.length > 0) await adopt($, { limits: copyLimits(usage.rateLimits), readAt: usage.startedAt })
}

async function checkPause($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (!autoPause || turnId === null || held !== null || latest === null || now < overrideUntil) return
  const hit = pauseTrigger(latest.limits, threshold)
  if (hit === undefined) return
  const resetsAt = resetsAtMs(hit)
  if (resetsAt === undefined) {
    $.ui.log(`session limit at ${hit.percentUsed}% but Claude Code reported no reset time, so no pause`)
    return
  }
  // A reading from a window that has since reset says nothing about the current one.
  if (resetsAt <= now) return
  await setPause($, { phase: 'pending', percentUsed: hit.percentUsed, resumeAt: resetsAt + RESUME_DELAY_MS })
  if (toolsRunning === 0) {
    await stopTurn($)
    return
  }
  $.ui.toast(`Session limit at ${hit.percentUsed}%: pausing once the running tool call finishes`)
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
  $.ui.log(
    `paused at ${held.percentUsed}% of the session limit; continuing at ${time.at(held.resumeAt, now)}. Send a prompt yourself to cancel.`,
  )
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

// Drops a pending or waiting pause without continuing anything.
async function cancelPause($: EngineInterface): Promise<void> {
  resumeTimer?.cancel()
  resumeTimer = null
  wasRefused = false
  if (held !== null) await setPause($, null)
}

async function report($: EngineInterface): Promise<string> {
  await fromShared($)
  await fromLastReply($)
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
      ...(zoneWarning === '' ? {} : { warning: zoneWarning }),
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
    if (autoPause && !e.isInteractive) {
      // A claude -p run or SDK host ends with its turn, so a paused run could never continue.
      autoPause = false
      $.ui.log('auto_pause is off in this session: it runs only where a person is at the prompt')
    }
    await fromShared($)
    await fromLastReply($)
    $.clock.every(SYNC_MS, () => {
      void fromShared($)
    })
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    await armResume($)
    await $.tool.register({
      name: 'plan_usage',
      description:
        "The Claude plan's usage limits right now, answered locally without a model call: one entry per window, with kind (five_hour is the session limit, seven_day the weekly one), percentUsed from 0 to 100, resetsAt as ISO 8601 and resetsAtLocal in the user's time zone. Check it before starting long or unattended work.",
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
    turnId = null
    await cancelPause($)
    if (latest !== null) await $.state.set(READING, latest)
    return next(e)
  })

  // A person at the keyboard outranks the pause: their prompt cancels it, and pausing stays off until the
  // session window resets, as with Claude Code's own wait.
  // Origins that mean a person sent the prompt: typed at the terminal (composer) or through Remote Control (bridge).
  on('prompt.submit', { origin: { kind: /^(composer|bridge)$/ } }, async ($, e, next) => {
    const hit = latest === null ? undefined : pauseTrigger(latest.limits, threshold)
    if (held !== null || (autoPause && hit !== undefined)) {
      const resetsAt = hit === undefined ? undefined : resetsAtMs(hit)
      overrideUntil = Math.max(overrideUntil, resetsAt ?? 0, held?.resumeAt ?? 0)
      if (held !== null) $.ui.toast('Pause cancelled: you sent a prompt')
      await cancelPause($)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await fromReply($, e.rateLimits)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A main turn that never reported turn.complete leaves its id behind; a new turn replaces it.
    turnId = e.turnId
    // A reading that crossed the threshold between turns applies to this one.
    await checkPause($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Subagent turns complete with agentId set and do not end the main turn.
    if (e.agentId === undefined && e.turnId === turnId) {
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

  on('tool.call', async ($, e, next) => {
    if (e.tool !== TOOL && held !== null) {
      wasRefused = true
      return {
        deny: `Paused: the plan's session limit is at ${held.percentUsed}%. Stop here; the session continues after the limit resets.`,
      }
    }
    toolsRunning += 1
    try {
      return e.tool === TOOL ? { result: await report($) } : await next(e)
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
