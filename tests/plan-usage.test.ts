// Budget: 25 tests, under 3 seconds together. Fakes only Claude Code's answers and the clock.
import type { UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'

import { BLUE, ORANGE, formatIn, isReading, resolveZone, timeFormat } from '../hooks/usage'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const TOOL = 'mcp__plan-usage__plan_usage'
// Sunday 2026-10-04 2:30 AM Central (CDT, UTC-5).
const NOW = Date.parse('2026-10-04T07:30:00Z')
const SESSION_RESET = '2026-10-04T09:10:00Z' // 4:10 AM CT
const WEEKLY_RESET = '2026-10-09T02:00:00Z' // Thu 9:00 PM CT
const RESUME_TEXT = 'Plan usage reset; resume where you left off from the files on disk.'
const CHICAGO = { time_zone: 'America/Chicago' }
const PAUSING = { ...CHICAGO, auto_pause: true }
const SHARED_KEY = 'reading:/Users/test/.claude'

interface Window {
  kind: string
  percentUsed: number
  resetsAt?: string
}

function windows(session: number, weekly: number, sessionReset = SESSION_RESET): Window[] {
  return [
    { kind: 'five_hour', percentUsed: session, resetsAt: sessionReset },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: WEEKLY_RESET },
  ]
}

interface Calls {
  aborted: string[]
  submitted: string[]
  logs: string[]
}

interface Fake {
  clock: MockClock
  calls: Calls
  store: Map<string, unknown>
}

// Every answer Claude Code would give; registered before the test's first $ call.
function engine(on: On, replyWindows: Window[]): Fake {
  const clock = mock.clock(on, { now: NOW })
  const calls: Calls = { aborted: [], submitted: [], logs: [] }
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/Users/test/.claude' }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: replyWindows },
  }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'plan-usage' } }))
  on('ui.log', ($, e) => {
    calls.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.abort', ($, e) => {
    calls.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind !== 'composer') calls.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // What the mods after this one draw in the shared band.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['a note from another mod'] }))
  // A tool call that takes one minute, so a pause can land while it runs.
  on('tool.call', async () => {
    await clock.sleep(60_000)
    return { result: 'ok' }
  })
  return { clock, calls, store }
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const BAND = {
  plugin: 'plan-usage',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 150, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

function measured(session: number, weekly: number, sessionReset = SESSION_RESET) {
  const changed: UsageUnit[] = ['rateLimits']
  return { context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: windows(session, weekly, sessionReset), changed }
}

async function band($: Engine, props: { hasSurvey?: boolean; bodyColumns?: number } = {}) {
  return $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface: 'terminal' })
}

async function answer(
  $: Engine,
): Promise<{ limits: Array<Record<string, unknown>>; autoPause: Record<string, unknown>; warning?: string }> {
  return JSON.parse(String((await $.tool.call({ tool: TOOL })).result))
}

function complete(turnId: string, agentId?: string) {
  return {
    turnId,
    answer: 'done',
    durationMs: 1_000,
    isAborted: false,
    reason: 'answer' as const,
    ...(agentId === undefined ? {} : { agentId }),
  }
}

// Starts a session at 50%, begins turn t1 with a one-minute tool call, and crosses the threshold during it.
async function pauseDuringTool($: Engine, clock: MockClock, percent = 96) {
  await $.session.start(START)
  await $.turn.start({ text: 'overnight work', turnId: 't1' })
  const running = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(1_000)
  await $.session.measure(measured(percent, 20))
  // Wrapped so callers do not await the call, which only finishes once the clock moves on.
  return { running }
}

// ---- The plan_usage tool ----

test('plan_usage answers each window with percent and local 12-hour reset times', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the tool dropping a window, mislabeling kinds, or printing UTC or 24-hour reset times.
  engine(on, windows(42, 63))
  await $.session.start(START)
  const out = await answer($)
  expect(out.limits).toMatchObject([
    {
      kind: 'five_hour',
      label: 'Session',
      percentUsed: 42,
      resetsAt: SESSION_RESET,
      resetsAtLocal: '4:10 AM CT',
      resetsIn: '1h 40m',
    },
    { kind: 'seven_day', label: 'Weekly', percentUsed: 63, resetsAt: WEEKLY_RESET, resetsAtLocal: 'Thu 9:00 PM CT' },
  ])
  expect(out.autoPause).toMatchObject({ isOn: false, threshold: 95, pause: null })
})

test(
  "plan_usage never passes this session's old figures off as newer than another session's",
  { options: CHICAGO },
  async ($, on) => {
    // GUARDS: the tool restamping the last reply as fresh and overwriting a newer shared reading (review finding 3).
    const { clock, store } = engine(on, windows(42, 63))
    await $.session.start(START)
    store.set(SHARED_KEY, { limits: windows(88, 64), readAt: NOW + 30_000 })
    await clock.advance(60_000)
    const out = await answer($)
    expect(out.limits[0]).toMatchObject({ percentUsed: 88 })
    expect(store.get(SHARED_KEY)).toMatchObject({ readAt: NOW + 30_000 })
  },
)

// ---- The band ----

test('band is blue OK under 80% and orange HIGH at 80%, and keeps other mods below it', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the 80% boundary moving, the level shown by color alone, or the band hiding later mods' lines.
  engine(on, windows(79.9, 80))
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: '● OK' }))?.props.color).toBe(BLUE)
    expect((await ui.find({ type: 'Text', text: '▲ HIGH' }))?.props.color).toBe(ORANGE)
    expect(await ui.find({ type: 'Text', text: /^Session 79\.9% · resets 4:10 AM CT \(1h 40m\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Weekly 80% · resets Thu 9:00 PM CT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'a note from another mod' })).toBeDefined()
    await ui.unmount()
  }
})

test('warn_at moves where the band turns orange', { options: { ...CHICAGO, warn_at: 90 } }, async ($, on) => {
  // GUARDS: the warning level ignoring the setting.
  engine(on, windows(85, 90))
  await $.session.start(START)
  const ui = await band($)
  expect((await ui.find({ type: 'Text', text: '● OK' }))?.props.color).toBe(BLUE)
  expect((await ui.find({ type: 'Text', text: '▲ HIGH' }))?.props.color).toBe(ORANGE)
})

test('band says plainly when there is no reading yet', { options: CHICAGO }, async ($, on) => {
  // GUARDS: a blank band before the first reply or off a claude.ai plan.
  engine(on, [])
  await $.session.start(START)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /no reading yet/ })).toBeDefined()
})

test(
  'band shows LIMIT at 100%, shortens when narrow, and dates figures older than 5 minutes',
  { options: CHICAGO },
  async ($, on) => {
    // GUARDS: losing the LIMIT level, the narrow layout overflowing, or old figures shown as current.
    const { clock } = engine(on, windows(100, 63))
    await $.session.start(START)
    await $.session.measure(measured(100, 63))
    const wide = await band($)
    expect((await wide.find({ type: 'Text', text: '■ LIMIT' }))?.props.color).toBe(ORANGE)
    expect(await wide.find({ type: 'Text', text: /^as of/ })).toBeUndefined()
    await wide.unmount()
    const narrow = await band($, { bodyColumns: 80 })
    expect(await narrow.find({ type: 'Text', text: /^Session 100% · 1h 40m$/ })).toBeDefined()
    await narrow.unmount()
    await clock.advance(6 * 60_000)
    const stale = await band($)
    expect(await stale.find({ type: 'Text', text: 'as of 2:30 AM CT' })).toBeDefined()
  },
)

test('band steps aside while Claude Code shows its survey', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the band covering Claude Code's feedback survey.
  engine(on, windows(42, 63))
  await $.session.start(START)
  const ui = await band($, { hasSurvey: true })
  expect(await ui.find({ type: 'Text', text: /Session/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'a note from another mod' })).toBeDefined()
})

// ---- Where the figures come from ----

test('a reply that moves the session limit past 80% turns the band orange and is shared', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the band freezing at its first reading, or replies never reaching idle sessions.
  const { store } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.session.measure(measured(85, 20))
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: '▲ HIGH' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Session 85%/ })).toBeDefined()
  expect((store.get(SHARED_KEY) as { limits: Window[] }).limits[0]).toMatchObject({ kind: 'five_hour', percentUsed: 85 })
})

test("an idle session picks up another session's newer reading and ignores an older one", { options: CHICAGO }, async ($, on) => {
  // GUARDS: idle sessions showing old figures, or an older stored reading replacing a newer one.
  const { clock, store } = engine(on, windows(42, 63))
  await $.session.start(START)
  await $.session.measure(measured(60, 63))
  store.set(SHARED_KEY, { limits: windows(10, 10), readAt: NOW - 60_000 })
  await clock.advance(60_000)
  const first = await band($)
  expect(await first.find({ type: 'Text', text: /^Session 60%/ })).toBeDefined()
  await first.unmount()
  store.set(SHARED_KEY, { limits: windows(88, 64), readAt: NOW + 90_000 })
  await clock.advance(60_000)
  expect(await (await band($)).find({ type: 'Text', text: /^Session 88%/ })).toBeDefined()
})

// ---- The pause ----

test('with auto-pause off, crossing 95% stops nothing', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the opt-in pause acting for someone who never turned it on.
  const { clock, calls } = engine(on, windows(50, 20))
  await pauseDuringTool($, clock, 97)
  await clock.advance(60_000)
  expect(calls.aborted).toEqual([])
})

test(
  'auto-pause lets the running tool finish, stops the turn, shows PAUSED, and continues at reset plus 2 minutes',
  { options: PAUSING },
  async ($, on) => {
    // GUARDS: cutting a tool call mid-run, never stopping, no PAUSED line, or continuing early or with the wrong prompt.
    const { clock, calls } = engine(on, windows(50, 20))
    const { running } = await pauseDuringTool($, clock)
    expect(calls.aborted).toEqual([])
    await clock.advance(60_000)
    expect((await running).result).toBe('ok')
    expect(calls.aborted).toEqual(['t1'])
    expect(await (await band($)).find({ type: 'Text', text: '⏸ PAUSED at 96% · continues 4:12 AM CT' })).toBeDefined()
    await clock.set(Date.parse(SESSION_RESET) + 119_000)
    expect(calls.submitted).toEqual([])
    await clock.advance(2_000)
    expect(calls.submitted).toEqual([RESUME_TEXT])
  },
)

test(
  'a pause that lands with no tool running stops the turn at once, with the configured prompt later',
  { options: { ...PAUSING, resume_prompt: 'Carry on.' } },
  async ($, on) => {
    // GUARDS: waiting forever for a tool call that is not running, or ignoring resume_prompt.
    const { clock, calls } = engine(on, windows(50, 20))
    await $.session.start(START)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.session.measure(measured(96, 20))
    expect(calls.aborted).toEqual(['t1'])
    await clock.set(Date.parse(SESSION_RESET) + 121_000)
    expect(calls.submitted).toEqual(['Carry on.'])
  },
)

test('a tool call that starts while a pause is pending is refused', { options: PAUSING }, async ($, on) => {
  // GUARDS: new work starting after the limit is reached (README: "New ones are refused").
  const { clock } = engine(on, windows(50, 20))
  await pauseDuringTool($, clock)
  const second = await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  expect(JSON.stringify(second)).toMatch(/Paused: the plan's session limit is at 96%/)
})

test('pause_threshold sets where the pause starts', { options: { ...PAUSING, pause_threshold: 90 } }, async ($, on) => {
  // GUARDS: the threshold setting being ignored.
  const { calls } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.session.measure(measured(89, 20))
  expect(calls.aborted).toEqual([])
  await $.session.measure(measured(91, 20))
  expect(calls.aborted).toEqual(['t1'])
})

test('only the session limit starts a pause, and never from a window that already reset', { options: PAUSING }, async ($, on) => {
  // GUARDS: pausing on the weekly limit (a 5-hour wait cannot help it), or on figures from an expired window.
  const { calls } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.session.measure(measured(50, 99))
  await $.session.measure(measured(97, 99, '2026-10-04T07:00:00Z'))
  expect(calls.aborted).toEqual([])
})

test('a reset that moved later before the continue time is waited for', { options: PAUSING }, async ($, on) => {
  // GUARDS: continuing into a window that is still at the limit.
  const { clock, calls, store } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.session.measure(measured(96, 20))
  store.set(SHARED_KEY, { limits: windows(97, 20, '2026-10-04T10:00:00Z'), readAt: NOW + 60_000 })
  await clock.set(Date.parse(SESSION_RESET) + 121_000)
  expect(calls.submitted).toEqual([])
  await clock.set(Date.parse('2026-10-04T10:00:00Z') + 121_000)
  expect(calls.submitted).toEqual([RESUME_TEXT])
})

test('/clear cancels a waiting continue', { options: PAUSING }, async ($, on) => {
  // GUARDS: a continue prompt landing in a cleared conversation (README: /clear cancels it).
  const { clock, calls } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.session.measure(measured(96, 20))
  await $.classic.SessionStart({ source: 'clear' })
  await clock.set(Date.parse(SESSION_RESET) + 10 * 60_000)
  expect(calls.submitted).toEqual([])
})

test(
  'a prompt you send cancels the pause, and pausing stays off until the window resets',
  { options: PAUSING },
  async ($, on) => {
    // GUARDS: a waiting pause refusing every tool call of the person at the keyboard (review finding 4).
    const { clock, calls } = engine(on, windows(50, 20))
    await $.session.start(START)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.session.measure(measured(96, 20))
    await $.prompt.submit({ text: 'what happened?', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'what happened?', turnId: 't2' })
    const read = $.tool.call({ tool: 'Read', file_path: 'a.md' })
    await clock.advance(60_000)
    expect(await read).toMatchObject({ result: 'ok' })
    await $.session.measure(measured(97, 20))
    expect(calls.aborted).toEqual(['t1'])
    await clock.set(Date.parse(SESSION_RESET) + 10 * 60_000)
    expect(calls.submitted).toEqual([])
  },
)

test(
  'a turn that was refused a tool call and then ended by itself still continues after the reset',
  { options: PAUSING },
  async ($, on) => {
    // GUARDS: losing the continue when the model stops on the refusal before the abort lands.
    const { clock, calls } = engine(on, windows(50, 20))
    const { running } = await pauseDuringTool($, clock)
    await $.tool.call({ tool: 'Read', file_path: 'a.md' })
    await $.turn.complete(complete('t1'))
    await clock.advance(60_000)
    await running
    await clock.set(Date.parse(SESSION_RESET) + 121_000)
    expect(calls.submitted).toEqual([RESUME_TEXT])
  },
)

test('a turn that finishes by itself during a pending pause is not continued later', { options: PAUSING }, async ($, on) => {
  // GUARDS: restarting finished work hours later because the limit was crossed in the turn's last reply.
  const { clock, calls } = engine(on, windows(50, 20))
  const { running } = await pauseDuringTool($, clock)
  await $.turn.complete(complete('t1'))
  await clock.advance(60_000)
  await running
  await clock.set(Date.parse(SESSION_RESET) + 10 * 60_000)
  expect(calls.submitted).toEqual([])
})

test("a subagent's turn ending does not end the main turn's pause", { options: PAUSING }, async ($, on) => {
  // GUARDS: a subagent finishing clearing the main turn and disabling the pause while other work runs.
  const { clock, calls } = engine(on, windows(50, 20))
  const { running } = await pauseDuringTool($, clock)
  await $.turn.complete(complete('t1', 'agent-1'))
  await clock.advance(60_000)
  await running
  expect(calls.aborted).toEqual(['t1'])
})

test('a threshold crossed between turns pauses the next turn as it starts', { options: PAUSING }, async ($, on) => {
  // GUARDS: a /loop or queued turn starting at 97% and running unpaused (review finding 2).
  const { calls } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.turn.start({ text: 'first', turnId: 't1' })
  await $.turn.complete(complete('t1'))
  await $.session.measure(measured(97, 20))
  await $.turn.start({ text: 'next loop iteration', turnId: 't2' })
  expect(calls.aborted).toEqual(['t2'])
})

test('auto-pause stays off in a claude -p run, which could never continue', { options: PAUSING }, async ($, on) => {
  // GUARDS: headless runs ending early with an empty result and exit code 0 (review finding 1).
  const { calls } = engine(on, windows(50, 20))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.session.measure(measured(99, 20))
  expect(calls.aborted).toEqual([])
  expect(calls.logs).toContain('auto_pause is off in this session: it runs only where a person is at the prompt')
})

// ---- Settings and formatting ----

test(
  'an invalid time_zone falls back to the system zone and says so',
  { options: { time_zone: 'Mars/Olympus' } },
  async ($, on) => {
    // GUARDS: a typo in the setting breaking the mod's load instead of degrading with a visible note.
    const { calls } = engine(on, windows(42, 63))
    await $.session.start(START)
    expect(calls.logs.some(line => line.startsWith('time_zone "Mars/Olympus" is not a time zone; showing '))).toBe(true)
    const out = await answer($)
    expect(out.limits).toHaveLength(2)
    expect(String(out.warning)).toMatch(/^time_zone "Mars\/Olympus" is not a time zone/)
  },
)

test('local times hold across daylight saving and zones without a short name; stored readings are checked', () => {
  // GUARDS: a fixed UTC offset (wrong half the year), long zone names in the band, and malformed shared readings.
  const winterNow = Date.parse('2026-12-01T12:00:00Z')
  const chicago = timeFormat('America/Chicago')
  expect(chicago.at(Date.parse('2026-12-01T15:00:00Z'), winterNow)).toBe('9:00 AM CT')
  expect(chicago.at(Date.parse('2026-12-20T15:00:00Z'), winterNow)).toBe('Dec 20 9:00 AM CT')
  expect(timeFormat('Europe/London').at(Date.parse('2026-10-04T08:00:00Z'), NOW)).toBe('9:00 AM GMT+1')
  expect(resolveZone('America/New_York')).toEqual({ zone: 'America/New_York', isFallback: false })
  expect(formatIn(26 * 3_600_000)).toBe('1d 2h')
  expect(formatIn(-5)).toBe('now')
  expect(isReading({ limits: windows(1, 2), readAt: NOW })).toBe(true)
  expect(isReading({ limits: [{ kind: 'five_hour', percentUsed: '9' }], readAt: NOW })).toBe(false)
})
