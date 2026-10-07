/** One Claude rate-limit window, as `$.session.usage()` reports it. */
export type ClaudeLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** What the band keeps from `$.session.usage()`. */
export type ClaudeSnap = {
  contextPercent: number | null
  rateLimits: ClaudeLimit[]
  costUsd: number | null
  /** Set when this chat has no reading of its own yet and shows another chat's: when that was taken. */
  borrowedAt?: number
}

export type CodexWindow = { used_percent: number; window_minutes: number; resets_at: number | string }

/** <claude config>/statusline-usage.json, as scripts/usage-scan.js writes it. */
export type ScanCache = {
  at: number
  starts?: Record<string, number>
  totals?: Record<string, number>
  codex?: { at: number; plan?: string; windows?: CodexWindow[] } | null
}

/** The last rate-limit reading each model family reported, shared by every session through a file. */
export type ModelReadings = Record<string, { at: number; limits: ClaudeLimit[] }>

export type Meta = { model: string; folder: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      claude: ClaudeSnap | null
      cache: ScanCache | null
      meta: Meta
      now: number
      isHidden: boolean
      toasted: string[]
      scanError: string | null
      models: ModelReadings
    }
  }
}
