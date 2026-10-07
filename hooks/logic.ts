// Pure port of extras/statusline.js: the same pace, colour and
// nudge rules, producing a view model instead of ANSI text.
import type { ClaudeLimit, ClaudeSnap, Meta, ModelReadings, ScanCache } from '../types'

export const H5 = 5 * 3600e3
export const D7 = 7 * 86400e3
export const BAR = 20
export const CBAR = 12

export type Tone = 'green' | 'yellow' | 'red' | 'magenta'

export type Bar = {
  label: string
  used: number
  color: Tone
  width: number
  extra: string
  /** The parts of `extra`, for the compact desktop layout. */
  tok?: string
  cap?: string
  resets?: string
  /** How far through its window we are, 0-100: where `used` would sit on pace. */
  elapsed?: number
  /** True while this window is the 🔥 kind: quota left and the reset close. */
  isUrgent?: boolean
  /** Where `used` must end this window to stay on the 7d plan, 0-100. */
  target?: number
}
export type Right = { kind: 'codex'; plan: string; seen: string } | ({ kind: 'bar' } & Bar)
export type Row = { left: Bar | null; right: Right | null }
export type Status =
  | { kind: 'wait'; text: string }
  | { kind: 'urgent' | 'nudge'; text: string }
  | { kind: 'ok'; text: string }
export type Urgent = { key: string; text: string }
export type View = {
  model: string
  folder: string
  cost: string | null
  status: Status
  rows: Row[]
  leftWidth: number
  urgent: Urgent[]
  plan: Plan | null
}

export const toMs = (v: unknown): number | null => {
  if (v == null) return null
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  const n = Number(v)
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n
  const t = Date.parse(String(v))
  return Number.isNaN(t) ? null : t
}

export const fmtDur = (ms: number): string => {
  if (ms <= 0) return '0m'
  const m = Math.floor(ms / 60000)
  const dd = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (dd) return `${dd}d${h}h`
  if (h) return `${h}h${String(mm).padStart(2, '0')}m`
  return `${mm}m`
}

export const fmtTok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const pct = (n: number): string => `${String(Math.round(n)).padStart(3)}%`

export const ctxColor = (p: number): Tone => (p >= 80 ? 'red' : p >= 60 ? 'yellow' : 'green')

/** Bar colour by pace: behind = elapsed% of window − used%. */
export const paceColor = (used: number, behind: number): Tone =>
  used >= 90 ? 'red' : behind > 25 ? 'magenta' : behind > 10 ? 'yellow' : 'green'

/** The Claude windows by label, 5h first, with each one's start. */
export const claudeWindows = (limits: ClaudeSnap['rateLimits']) => {
  const out: { label: string; used: number; resetsAt?: string; len: number }[] = []
  for (const [kind, label, len] of [['five_hour', '5h', H5], ['seven_day', '7d', D7]] as const) {
    const w = limits.find(l => l.kind === kind)
    if (w) out.push({ label, used: w.percentUsed, resetsAt: w.resetsAt, len })
  }
  return out
}

/** Window starts (reset − length) that usage-scan.js takes as `<label>=<ms>`. */
export const windowStarts = (limits: ClaudeSnap['rateLimits']): Record<string, number> => {
  const starts: Record<string, number> = {}
  for (const w of claudeWindows(limits)) {
    const r = toMs(w.resetsAt)
    if (r) starts[w.label] = r - w.len
  }
  return starts
}

export const sameWindows = (cache: ScanCache | null, starts: Record<string, number>): boolean =>
  Object.keys(starts).every(k => Math.abs((cache?.starts?.[k] ?? 0) - (starts[k] ?? 0)) < 60e3)

/** True when the CLI would spawn usage-scan.js: no cache, moved windows, or >60 s old. */
export const needsScan = (cache: ScanCache | null, starts: Record<string, number>, now: number): boolean =>
  Object.keys(starts).length > 0 && (!cache || !sameWindows(cache, starts) || now - cache.at > 60e3)

type WindowStat = { used: number; msLeft: number | null; tok?: number }

/** How hard the remaining 5h windows must be used for the 7d quota not to expire. */
export type Plan = {
  /** 5h windows that can still spend 7d quota: the running one and those startable before the 7d reset. */
  windows: number
  /** Share of every remaining 5h window's free capacity to use, 0-100; capped at 100 when not `isFeasible`. */
  needPct: number
  /** Where the running 5h window's `used` should end, 0-100; absent when none is running. */
  target?: number
  isFeasible: boolean
  /** Share of the week that expires even with every window maxed, 0-100. */
  wastePct: number
}

/**
 * Capacities are extrapolated (tokens ÷ fraction used), so a full 5h window is worth cap5 ÷ cap7 of
 * the week. Needs both token totals and at least 1% used in each window.
 */
export const planFiveHour = (five: WindowStat | undefined, seven: WindowStat | undefined): Plan | null => {
  if (!five || !seven || seven.msLeft == null) return null
  if (five.tok == null || seven.tok == null || five.used < 1 || seven.used < 1) return null
  const perWindow = ((five.tok / five.used) / (seven.tok / seven.used)) * 100
  if (!(perWindow > 0)) return null
  const left7 = Math.max(0, 100 - seven.used)
  const isRunning = five.msLeft != null
  const current = isRunning ? ((100 - five.used) / 100) * perWindow : 0
  const after = seven.msLeft - (five.msLeft ?? 0)
  const later = after > 0 ? Math.ceil(after / H5) : 0
  const available = current + later * perWindow
  if (!(available > 0)) return null
  const share = Math.min(1, left7 / available)
  return {
    windows: (isRunning ? 1 : 0) + later,
    needPct: share * 100,
    target: isRunning ? five.used + share * (100 - five.used) : undefined,
    isFeasible: left7 <= available,
    wastePct: Math.max(0, left7 - available),
  }
}

type Nudge = { score: number; msg: string; urgent: boolean }

export const buildView = (
  claude: ClaudeSnap | null,
  cache: ScanCache | null,
  meta: Meta,
  now: number,
): View => {
  const limits = claude?.rateLimits ?? []
  const starts = windowStarts(limits)
  const scan = Object.keys(starts).length ? cache : null
  const planTok = scan && sameWindows(scan, starts) ? scan.totals ?? {} : {}
  let nudge: Nudge | null = null
  const urgent: Urgent[] = []

  const analyze = (label: string, usedPct: unknown, resetsAt: unknown, len: number, who: string) => {
    let used = Number(usedPct ?? 0)
    const reset = toMs(resetsAt)
    let msLeft: number | null = reset ? reset - now : null
    // A snapshot older than its window means the window has already reset.
    if (msLeft != null && msLeft <= 0) {
      used = 0
      msLeft = null
    }
    const left = Math.max(0, 100 - used)
    const elapsedFrac = msLeft != null ? Math.min(1, Math.max(0, 1 - msLeft / len)) : null
    const behind = elapsedFrac != null ? elapsedFrac * 100 - used : 0
    const col = paceColor(used, behind)
    let isUrgent = false

    if (msLeft != null && left >= 20) {
      const urgentWindow = label === '5h' ? msLeft < 90 * 60e3 : msLeft < 36 * 3600e3
      const score = behind + (urgentWindow ? 50 : 0)
      const msg = urgentWindow
        ? `🔥 ${who}${left.toFixed(0)}% of ${label} quota expires in ${fmtDur(msLeft)} — USE IT!`
        : `⚡ ${who}${left.toFixed(0)}% of ${label} quota unused — go build something!`
      isUrgent = urgentWindow
      if (urgentWindow) urgent.push({ key: `${who || 'Claude: '}${label}@${reset}`, text: msg })
      if ((behind > 10 || urgentWindow) && (!nudge || score > nudge.score)) {
        nudge = { score, msg, urgent: urgentWindow }
      }
    }
    return { used, left, msLeft, col, elapsed: elapsedFrac != null ? elapsedFrac * 100 : undefined, isUrgent }
  }

  const rows: Row[] = []
  const keys: (string | null)[] = []
  if (claude?.contextPercent != null) {
    rows.push({
      left: { label: 'ctx', used: claude.contextPercent, color: ctxColor(claude.contextPercent), width: BAR, extra: '  context' },
      right: null,
    })
    keys.push(null)
  }

  const claudeLeft: Record<string, number> = {}
  const stats: Record<string, WindowStat> = {}
  let shown = 0
  for (const w of claudeWindows(limits)) {
    const a = analyze(w.label, w.used, w.resetsAt, w.len, '')
    claudeLeft[w.label] = a.left
    const resetTxt = a.msLeft != null ? `  resets in ${fmtDur(a.msLeft)}` : ''
    // Total capacity is extrapolated: tokens spent so far ÷ fraction used.
    const tok = planTok[w.label]
    stats[w.label] = { used: a.used, msLeft: a.msLeft, tok }
    let tokTxt = ''
    const cap = tok != null && a.used >= 1 ? fmtTok((tok / a.used) * 100) : undefined
    if (tok != null) {
      tokTxt = ` ≈ ${fmtTok(tok)}`
      if (cap) tokTxt += ` of ~${cap} tok`
    }
    rows.push({
      left: {
        label: w.label,
        used: a.used,
        color: a.col,
        width: BAR,
        extra: `  used${tokTxt}${resetTxt}`,
        tok: tok != null ? fmtTok(tok) : undefined,
        cap,
        resets: a.msLeft != null ? fmtDur(a.msLeft) : undefined,
        elapsed: a.elapsed,
        isUrgent: a.isUrgent,
      },
      right: null,
    })
    keys.push(w.label)
    shown++
  }

  const plan = planFiveHour(stats['5h'], stats['7d'])
  const fiveRow = rows[keys.indexOf('5h')]?.left
  if (plan && fiveRow) fiveRow.target = plan.target

  // Codex column, right of the Claude bars, rows matched by window length.
  const cx = scan?.codex
  if (cx) {
    if (!rows.length) {
      rows.push({ left: null, right: null })
      keys.push(null)
    }
    rows[0]!.right = { kind: 'codex', plan: cx.plan ?? '', seen: fmtDur(now - cx.at) }
    for (const w of cx.windows ?? []) {
      const label = w.window_minutes === 300 ? '5h' : w.window_minutes === 10080 ? '7d' : `${w.window_minutes}m`
      const a = analyze(label, w.used_percent, w.resets_at, w.window_minutes * 60e3, 'Codex: ')
      // Out of Claude quota but Codex has room → suggest switching.
      const current: Nudge | null = nudge
      if ((claudeLeft[label] ?? 100) < 10 && a.left >= 20 && !current?.urgent) {
        nudge = { score: 999, msg: `↪ Claude ${label} nearly out — switch to Codex (${a.left.toFixed(0)}% left)`, urgent: false }
      }
      let i = keys.indexOf(label)
      if (i < 0) {
        rows.push({ left: null, right: null })
        keys.push(label)
        i = rows.length - 1
      }
      rows[i]!.right = {
        kind: 'bar',
        label,
        used: a.used,
        color: a.col,
        width: CBAR,
        extra: a.msLeft != null ? `  resets in ${fmtDur(a.msLeft)}` : '  reset',
        resets: a.msLeft != null ? fmtDur(a.msLeft) : undefined,
        elapsed: a.elapsed,
        isUrgent: a.isUrgent,
      }
    }
  }

  const final: Nudge | null = nudge
  const status: Status = !shown
    ? { kind: 'wait', text: 'quota: waiting for first API response…' }
    : final
      ? { kind: final.urgent ? 'urgent' : 'nudge', text: final.msg }
      : { kind: 'ok', text: '✓ on pace' }

  const leftWidth = Math.max(0, ...rows.map(r => (r.left ? barText(r.left).length : 0)))
  return {
    model: meta.model,
    folder: meta.folder,
    cost: claude?.costUsd != null ? `session $${claude.costUsd.toFixed(2)}` : null,
    status,
    rows,
    leftWidth,
    urgent,
    plan,
  }
}

/** A bar row as plain text, the width the CLI pads the Claude column to. */
export const barText = (b: Bar): string => {
  const labelWidth = b.width === BAR ? 4 : 3
  return `${b.label.padEnd(labelWidth)}${'x'.repeat(b.width)} ${pct(b.used)}${b.extra}`
}

export const barCells = (b: Bar, width = b.width): { full: string; track: string } => {
  const p = Math.max(0, Math.min(100, b.used))
  const full = Math.round((p / 100) * width)
  return { full: '█'.repeat(full), track: '░'.repeat(width - full) }
}

/** `claude-fable-5-1` → `fable`; a name with no known family is kept whole. */
export const family = (model: string): string => /fable|opus|sonnet|haiku/.exec(model.toLowerCase())?.[0] ?? model

type Reading = { at: number; limits: ClaudeLimit[] }

/**
 * Each window (5h, 7d) from whichever reading has it most recently: every chat and model shares one
 * quota, so another chat's newer figure beats this chat's own. `own.at` is 0 when unknown, so own
 * figures only win a window nobody else has. `borrowedAt` is the oldest borrowed reading's time.
 */
export const freshestLimits = (own: Reading, shared: Reading[]): { limits: ClaudeLimit[]; borrowedAt?: number } => {
  const kinds = [...new Set([...own.limits, ...shared.flatMap(r => r.limits)].map(l => l.kind))]
  let borrowedAt: number | undefined
  const limits = kinds.flatMap(kind => {
    const mine = own.limits.find(l => l.kind === kind)
    const theirs = shared
      .filter(r => r.limits.some(l => l.kind === kind) && (!mine || r.at > own.at + 5_000))
      .sort((a, b) => b.at - a.at)[0]
    if (!theirs) return mine ? [mine] : []
    borrowedAt = borrowedAt == null ? theirs.at : Math.min(borrowedAt, theirs.at)
    return theirs.limits.filter(l => l.kind === kind)
  })
  return { limits, borrowedAt }
}
