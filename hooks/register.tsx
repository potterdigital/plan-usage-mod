import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import type { PlanUsageLimit, PlanUsageOnboarding, PlanUsagePause, PlanUsageReading } from '../types'
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
const OVERRIDE = { plugin: 'plan-usage', key: 'overrideUntil' } as const
const ONBOARDING = { plugin: 'plan-usage', key: 'onboarding' } as const
// Set in $.store once someone has chosen show_at on this machine, so the first-run line shows once.
const ONBOARDED_KEY = 'onboarded'

const TOOL = 'mcp__plan-usage__plan_usage'
// How often an idle session looks for a newer reading another session stored. A local file read.
const SYNC_MS = 60_000
// Redraws the band so "resets in" counts down.
const TICK_MS = 30_000
const STALE_MS = 5 * 60_000
const BAND_KINDS = ['five_hour', 'seven_day']

let warnAt = 80
let showAt = 0
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

async function setOverride($: EngineInterface, until: number): Promise<void> {
  overrideUntil = until
  await $.state.set(OVERRIDE, until)
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
  // A prompt can cancel the pause while the abort is awaited, so work from this copy.
  const pause: PlanUsagePause = { ...held, phase: 'waiting' }
  const stopping = turnId
  turnId = null
  await setPause($, pause)
  if (stopping !== null) {
    try {
      await $.turn.abort({ turnId: stopping })
    } catch (error) {
      $.ui.log(`could not stop the turn: ${String(error)}`, { to: 'debug' })
    }
  }
  const now = await $.clock.now()
  $.ui.log(
    `paused at ${pause.percentUsed}% of the session limit; continuing at ${time.at(pause.resumeAt, now)}. Send a prompt yourself to cancel.`,
  )
  await armResume($)
  // The stopped turn's turn.complete no longer matches turnId, so a first-run choice it held is saved here.
  if (pendingShowAt !== null) await saveShowAt($, pendingShowAt)
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

// The first-run choice: shown until someone on this computer has saved one.
let needsChoice = false
// A choice made while a turn runs, saved when the main turn ends: saving reloads this module.
let pendingShowAt: number | null = null

async function chooseShowAt($: EngineInterface, percent: number): Promise<void> {
  showAt = percent
  await $.state.set(ONBOARDING, null)
  if (turnId !== null) {
    pendingShowAt = percent
    $.ui.toast(`Plan usage: ${shownFrom(percent)}. Saved when this turn ends.`)
    return
  }
  await saveShowAt($, percent)
}

function shownFrom(percent: number): string {
  return percent === 0 ? 'always shown' : `shown from ${percent}%`
}

// Saves show_at where /config shows it. The key is "<plugin name>.<field>", read live under a marketplace
// install (plan-usage@potterdigital) on Claude Code 2.1.289. Saving reloads the module, so the done flag is
// written first and taken back if the save is refused.
async function saveShowAt($: EngineInterface, percent: number): Promise<void> {
  pendingShowAt = null
  await $.store.set(ONBOARDED_KEY, true)
  let refusal: string | undefined
  try {
    refusal = (await $.config.set({ key: 'plan-usage.show_at', value: percent })).deny
  } catch (error) {
    refusal = String(error)
  }
  if (refusal !== undefined) {
    await $.store.set(ONBOARDED_KEY, false)
    const retry: PlanUsageOnboarding = { step: 'choose', note: 'Could not save that. Choose again, or set show_at in /config.' }
    await $.state.set(ONBOARDING, retry)
    $.ui.log(`show_at was not saved: ${refusal}`)
    return
  }
  needsChoice = false
  $.ui.toast(`Plan usage: ${shownFrom(percent)}. Change it in /config.`)
}

async function submitOtherPercent($: EngineInterface, text: string): Promise<void> {
  const entry = text.trim()
  const percent = Number(entry)
  if (!/^\d{1,3}$/.test(entry) || percent > 100) {
    const retry: PlanUsageOnboarding = { step: 'other', note: 'Enter a whole number from 0 to 100.' }
    await $.state.set(ONBOARDING, retry)
    return
  }
  await chooseShowAt($, percent)
}

async function askOtherPercent($: EngineInterface): Promise<void> {
  const other: PlanUsageOnboarding = { step: 'other' }
  await $.state.set(ONBOARDING, other)
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
  showAt = typeof options.show_at === 'number' ? options.show_at : 0
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
    overrideUntil = (await $.state.get(OVERRIDE)).value ?? 0
    if (zoneWarning !== '') $.ui.log(zoneWarning)
    if (autoPause && !e.isInteractive) {
      // A claude -p run or SDK host ends with its turn, so a paused run could never continue.
      autoPause = false
      $.ui.log('auto_pause is off in this session: it runs only where a person is at the prompt')
    }
    needsChoice = e.isInteractive && (await $.store.get(ONBOARDED_KEY)) !== true
    if (needsChoice) {
      const choose: PlanUsageOnboarding = { step: 'choose' }
      await $.state.set(ONBOARDING, choose)
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
    if (overrideUntil > 0) await $.state.set(OVERRIDE, overrideUntil)
    if (pendingShowAt !== null) {
      await saveShowAt($, pendingShowAt)
    } else if (needsChoice) {
      const choose: PlanUsageOnboarding = { step: 'choose' }
      await $.state.set(ONBOARDING, choose)
    }
    return next(e)
  })

  // A person outranks the pause. A prompt they send that starts its own turn (one typed while a turn runs is
  // queued into it, and leaves the pause alone) cancels a pause, and pausing stays off until the session window
  // resets. A prompt sent past the threshold with no pause yet is paused at turn.start like any other, so the
  // override is always a deliberate second prompt. Origins: the terminal, Remote Control, and the owner on Slack.
  on('prompt.submit', { origin: { kind: /^(composer|bridge|slack-ping)$/ } }, async ($, e, next) => {
    if (held !== null && e.turnId === undefined) {
      await setOverride($, Math.max(overrideUntil, held.resumeAt - RESUME_DELAY_MS))
      $.ui.toast(`Pause cancelled: you sent a prompt. No pausing until ${time.at(overrideUntil, await $.clock.now())}.`)
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
    // Last: saving the first-run choice reloads the module, so the pause above is settled first.
    if (e.agentId === undefined && pendingShowAt !== null && turnId === null) await saveShowAt($, pendingShowAt)
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
    const pauseOffUntil = (await $.state.get(OVERRIDE)).value ?? 0
    const onboarding = (await $.state.get(ONBOARDING)).value ?? null
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const isNarrow = e.props.bodyColumns < 100
    // The band is shared: keep what the mods after this one draw (Claude Code's own notes included) under these lines.
    const theirs = await next(e)

    // The first-run choice, above the usage line. It needs a text field, which the terminal and the desktop app have.
    let choice = null
    if (onboarding !== null && (e.surface === 'terminal' || e.surface === 'desktop')) {
      const { Button, Input } = $.ui.resolve(e)
      choice =
        onboarding.step === 'choose' ? (
          <Box flexDirection="row" columnGap={2}>
            <Text>Plan usage: show your limits above the prompt</Text>
            <Button key="show-always" label="Always" hotkey="1" plain onPress={() => chooseShowAt($, 0)} />
            <Button key="show-50" label="From 50%" hotkey="2" plain onPress={() => chooseShowAt($, 50)} />
            <Button key="show-80" label="From 80%" hotkey="3" plain onPress={() => chooseShowAt($, 80)} />
            <Button key="show-other" label="Other" hotkey="4" plain onPress={() => askOtherPercent($)} />
            {onboarding.note === undefined ? null : <Text>{onboarding.note}</Text>}
          </Box>
        ) : (
          <Box flexDirection="row" columnGap={2}>
            <Input
              key="show-at"
              label="Plan usage: show limits from what percent"
              placeholder="0 to 100"
              value=""
              submitLabel="save"
              autoFocus
              onSubmit={(text: string) => submitOtherPercent($, text)}
            />
            {onboarding.note === undefined ? null : <Text>{onboarding.note}</Text>}
          </Box>
        )
    }

    let usage = null
    if (current === null) {
      if (showAt === 0) usage = <Text wrap="truncate-end">◌ Plan usage: no reading yet (it appears after the first reply)</Text>
    } else {
      const shown = BAND_KINDS.flatMap(kind => current.limits.filter(limit => limit.kind === kind && limit.percentUsed >= showAt))
      const isStale = now - current.readAt > STALE_MS
      const isOverridden = autoPause && pausing === null && now < pauseOffUntil
      // Below show_at, with nothing paused or overridden, the usage line steps aside.
      if (shown.length > 0 || pausing !== null || isOverridden) {
        usage = (
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
            {isOverridden ? <Text wrap="truncate-end">○ pause off until {time.at(pauseOffUntil, now)}</Text> : null}
            {isStale && shown.length > 0 ? <Text wrap="truncate-end">as of {time.at(current.readAt, now)}</Text> : null}
          </Box>
        )
      }
    }

    if (choice === null && usage === null) return theirs
    return (
      <Box flexDirection="column">
        {choice}
        {usage}
        {theirs}
      </Box>
    )
  })
}
