// Budget: 11 tests, under 3 seconds together. Fakes only Claude Code's answers and the clock.
import type { UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { MockClock, TestBody } from 'claude-code/testing'

import { BLUE, ORANGE, formatIn, isReading, resolveZone, timeFormat } from '../hooks/usage'

type On = Parameters<TestBody>[1]

const TOOL = 'mcp__plan-usage__plan_usage'
// Sunday 2026-10-04 2:30 AM Central (CDT, UTC-5).
const NOW = Date.parse('2026-10-04T07:30:00Z')
const SESSION_RESET = '2026-10-04T09:10:00Z' // 4:10 AM CT
const WEEKLY_RESET = '2026-10-09T02:00:00Z' // Thu 9:00 PM CT
const CHICAGO = { time_zone: 'America/Chicago' }
const PAUSING = { ...CHICAGO, auto_pause: true }
const SHARED_KEY = 'reading:/Users/test/.claude'

interface Window {
  kind: string
  percentUsed: number
  resetsAt?: string
}

function windows(session: number, weekly: number): Window[] {
  return [
    { kind: 'five_hour', percentUsed: session, resetsAt: SESSION_RESET },
    { kind: 'seven_day', percentUsed: weekly, resetsAt: WEEKLY_RESET },
  ]
}

interface Calls {
  aborted: string[]
  submitted: string[]
  logs: string[]
}

// Every answer Claude Code would give; registered before the test's first $ call.
function engine(on: On, replyWindows: Window[]): { clock: MockClock; calls: Calls; store: Map<string, unknown> } {
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
    calls.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // What the mods after this one draw in the shared band.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['a note from another mod'] }))
  // A Bash call that takes one minute, so a pause can land while it runs.
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

function measured(session: number, weekly: number) {
  const changed: UsageUnit[] = ['rateLimits']
  return { context: { tokens: 0, window: 200_000, percent: 0 }, rateLimits: windows(session, weekly), changed }
}

test('plan_usage answers each window with percent and local 12-hour reset times', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the tool dropping a window, mislabeling kinds, or printing UTC or 24-hour reset times.
  engine(on, windows(42, 63))
  await $.session.start(START)
  const answer = JSON.parse(String((await $.tool.call({ tool: TOOL })).result))
  expect(answer.limits).toMatchObject([
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
  expect(answer.timeZone).toBe('America/Chicago')
  expect(answer.autoPause).toMatchObject({ isOn: false, threshold: 95, pause: null })
})

test('band is blue OK under 80% and orange HIGH at 80%, and keeps other mods below it', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the 80% boundary moving, the level shown by color alone, or the band hiding other mods' lines.
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
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '● OK' }))?.props.color).toBe(BLUE)
  expect((await ui.find({ type: 'Text', text: '▲ HIGH' }))?.props.color).toBe(ORANGE)
})

test('band says plainly when there is no reading yet', { options: CHICAGO }, async ($, on) => {
  // GUARDS: a blank band before the first reply or off a claude.ai plan.
  engine(on, [])
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /no reading yet/ })).toBeDefined()
})

test('a reply that moves the session limit past 80% turns the band orange', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the band freezing at its first reading instead of following each reply.
  engine(on, windows(50, 20))
  await $.session.start(START)
  await $.session.measure(measured(85, 20))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '▲ HIGH' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Session 85%/ })).toBeDefined()
})

test("an idle session picks up another session's newer reading", { options: CHICAGO }, async ($, on) => {
  // GUARDS: idle sessions showing old figures while another session on the same login gets new ones.
  const { clock, store } = engine(on, windows(42, 63))
  await $.session.start(START)
  store.set(SHARED_KEY, { limits: windows(88, 64), readAt: NOW + 30_000 })
  await clock.advance(60_000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Session 88%/ })).toBeDefined()
})

test('with auto-pause off, crossing 95% stops nothing', { options: CHICAGO }, async ($, on) => {
  // GUARDS: the opt-in pause acting for someone who never turned it on.
  const { calls } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.session.measure(measured(97, 20))
  expect(calls.aborted).toEqual([])
})

test(
  'auto-pause lets the running tool finish, stops the turn, and continues at reset plus 2 minutes',
  { options: PAUSING },
  async ($, on) => {
    // GUARDS: cutting a tool call mid-run, never stopping, continuing early, or continuing with the wrong prompt.
    const { clock, calls } = engine(on, windows(50, 20))
    await $.session.start(START)
    await $.turn.start({ text: 'overnight work', turnId: 't1' })
    const running = $.tool.call({ tool: 'Bash', command: 'npm test' })
    await clock.advance(1_000)
    await $.session.measure(measured(96, 20))
    expect(calls.aborted).toEqual([])
    await clock.advance(60_000)
    expect((await running).result).toBe('ok')
    expect(calls.aborted).toEqual(['t1'])
    await clock.set(Date.parse(SESSION_RESET) + 119_000)
    expect(calls.submitted).toEqual([])
    await clock.advance(2_000)
    expect(calls.submitted).toEqual(['Plan usage reset; resume where you left off from the files on disk.'])
  },
)

test('a turn that finishes by itself during a pending pause is not continued later', { options: PAUSING }, async ($, on) => {
  // GUARDS: restarting finished work hours later because the limit was crossed in the turn's last reply.
  const { clock, calls } = engine(on, windows(50, 20))
  await $.session.start(START)
  await $.turn.start({ text: 'quick question', turnId: 't1' })
  const running = $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(1_000)
  await $.session.measure(measured(96, 20))
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await clock.advance(60_000)
  await running
  await clock.set(Date.parse(SESSION_RESET) + 10 * 60_000)
  expect(calls.submitted).toEqual([])
})

test(
  'an invalid time_zone falls back to the system zone and says so',
  { options: { time_zone: 'Mars/Olympus' } },
  async ($, on) => {
    // GUARDS: a typo in the setting breaking the mod's load instead of degrading with a visible note.
    const { calls } = engine(on, windows(42, 63))
    await $.session.start(START)
    expect(calls.logs.some(line => line.startsWith('time_zone "Mars/Olympus" is not a time zone; showing '))).toBe(true)
    const answer = JSON.parse(String((await $.tool.call({ tool: TOOL })).result))
    expect(answer.limits).toHaveLength(2)
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
