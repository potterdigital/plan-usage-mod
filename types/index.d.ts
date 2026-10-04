// One plan-limit window as Claude Code reports it: `five_hour` (the session limit), `seven_day` (weekly),
// the per-model weekly windows, or a gateway's `spend_limit`.
export interface PlanUsageLimit {
  kind: string
  percentUsed: number
  resetsAt?: string
}

// The newest figures, from the last model reply this session or another session on the same login saw.
export interface PlanUsageReading {
  limits: PlanUsageLimit[]
  readAt: number
}

// An auto-pause in progress: `pending` waits for running tool calls, `waiting` waits for the reset.
export interface PlanUsagePause {
  phase: 'pending' | 'waiting'
  percentUsed: number
  resumeAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'plan-usage': {
      reading: PlanUsageReading | null
      pause: PlanUsagePause | null
    }
  }
}
