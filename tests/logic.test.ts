import { describe, expect, test } from 'claude-code/testing'

import type { ClaudeSnap, ScanCache } from '../types'
import { buildView, ctxColor, fmtDur, freshestLimits, needsScan, paceColor, planFiveHour, windowStarts } from '../hooks/logic'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const META = { model: 'Opus 5.5', folder: 'my-project' }
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString()
const H = 3600e3

const snap = (fiveUsed: number, fiveLeftMs: number, sevenUsed: number, sevenLeftMs: number): ClaudeSnap => ({
  contextPercent: 42,
  costUsd: 1.234,
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveUsed, resetsAt: iso(fiveLeftMs) },
    { kind: 'seven_day', percentUsed: sevenUsed, resetsAt: iso(sevenLeftMs) },
  ],
})

describe('colours', () => {
  test('context thresholds', () => {
    expect(ctxColor(59)).toBe('green')
    expect(ctxColor(60)).toBe('yellow')
    expect(ctxColor(80)).toBe('red')
  })

  test('pace: red ≥90 used, magenta >25 behind, yellow >10 behind', () => {
    expect(paceColor(90, 0)).toBe('red')
    expect(paceColor(10, 26)).toBe('magenta')
    expect(paceColor(10, 11)).toBe('yellow')
    expect(paceColor(10, 10)).toBe('green')
  })

  test('durations', () => {
    expect(fmtDur(2 * H + 5 * 60e3)).toBe('2h05m')
    expect(fmtDur(26 * H)).toBe('1d2h')
    expect(fmtDur(-1)).toBe('0m')
  })
})

describe('status message', () => {
  test('on pace', () => {
    // 5h: 2.5h of 5h elapsed (50%), 50% used; 7d: 3.5d elapsed, 50% used.
    const v = buildView(snap(50, 2.5 * H, 50, 84 * H), null, META, NOW)
    expect(v.status).toEqual({ kind: 'ok', text: '✓ on pace' })
    expect(v.cost).toBe('session $1.23')
  })

  test('urgent 5h beats behind-pace 7d, and is listed for a toast', () => {
    const v = buildView(snap(30, 70 * 60e3, 10, 100 * H), null, META, NOW)
    expect(v.status).toEqual({ kind: 'urgent', text: '🔥 70% of 5h quota expires in 1h10m — USE IT!' })
    expect(v.urgent.length).toBe(1)
    expect(v.rows[1]?.left?.color).toBe('magenta')
    expect(v.rows[1]?.left?.isUrgent).toBe(true)
    expect(v.rows[2]?.left?.isUrgent).toBe(false)
  })

  test('urgent needs ≥20% left', () => {
    const v = buildView(snap(85, 30 * 60e3, 50, 84 * H), null, META, NOW)
    expect(v.status.kind).toBe('ok')
    expect(v.urgent.length).toBe(0)
  })

  test('7d urgent under 36 h', () => {
    const v = buildView(snap(50, 2.5 * H, 70, 30 * H), null, META, NOW)
    expect(v.status).toEqual({ kind: 'urgent', text: '🔥 30% of 7d quota expires in 1d6h — USE IT!' })
  })

  test('behind pace → ⚡', () => {
    // 7d: 100 h of 168 elapsed (≈59.5%), 20% used → behind ≈ 39.5.
    const v = buildView(snap(50, 2.5 * H, 20, 68 * H), null, META, NOW)
    expect(v.status).toEqual({ kind: 'nudge', text: '⚡ 80% of 7d quota unused — go build something!' })
  })

  test('Claude nearly out with Codex room → switch', () => {
    const cache: ScanCache = {
      at: NOW,
      starts: windowStarts(snap(95, 2.5 * H, 50, 84 * H).rateLimits),
      totals: { '5h': 1_000_000, '7d': 9_000_000 },
      codex: { at: NOW - 9 * 60e3, plan: 'prolite', windows: [{ used_percent: 40, window_minutes: 300, resets_at: (NOW + 2.5 * H) / 1000 }] },
    }
    const v = buildView(snap(95, 2.5 * H, 50, 84 * H), cache, META, NOW)
    expect(v.status).toEqual({ kind: 'nudge', text: '↪ Claude 5h nearly out — switch to Codex (60% left)' })
    expect(v.rows[0]?.right).toEqual({ kind: 'codex', plan: 'prolite', seen: '9m' })
    expect(v.rows[1]?.right?.kind).toBe('bar')
    expect(v.rows[1]?.left?.extra).toBe('  used ≈ 1.0M of ~1.1M tok  resets in 2h30m')
  })

  test('no rate limits yet', () => {
    const v = buildView({ contextPercent: 5, costUsd: null, rateLimits: [] }, null, META, NOW)
    expect(v.status.kind).toBe('wait')
  })

  test('a window whose reset is past counts as 0% used', () => {
    const v = buildView(snap(70, -60e3, 50, 84 * H), null, META, NOW)
    expect(v.rows[1]?.left?.used).toBe(0)
    expect(v.rows[1]?.left?.extra).toBe('  used')
  })
})

describe('scan refresh', () => {
  const starts = { '5h': NOW - H, '7d': NOW - 24 * H }
  test('fresh cache with matching starts is kept', () => {
    expect(needsScan({ at: NOW - 30e3, starts }, starts, NOW)).toBe(false)
  })
  test('stale or moved windows rescan', () => {
    expect(needsScan({ at: NOW - 61e3, starts }, starts, NOW)).toBe(true)
    expect(needsScan({ at: NOW, starts: { ...starts, '5h': NOW - 2 * H } }, starts, NOW)).toBe(true)
    expect(needsScan(null, starts, NOW)).toBe(true)
  })
})

describe('7d plan from 5h windows', () => {
  // cap5 = 2M, cap7 = 10M → a full 5h window is 20% of the week.
  const five = { used: 50, msLeft: 2.5 * H, tok: 1_000_000 }

  test('feasible: share of each remaining window', () => {
    // 40% of the week left; running window holds 10, two later windows 40 → need 40/50.
    const p = planFiveHour(five, { used: 60, msLeft: 12.5 * H, tok: 6_000_000 })
    expect(p?.windows).toBe(3)
    expect(Math.round(p?.needPct ?? 0)).toBe(80)
    expect(Math.round(p?.target ?? 0)).toBe(90)
    expect(p?.isFeasible).toBe(true)
  })

  test('infeasible: some of the week expires even maxed out', () => {
    const p = planFiveHour(five, { used: 20, msLeft: 12.5 * H, tok: 2_000_000 })
    expect(p?.isFeasible).toBe(false)
    expect(Math.round(p?.wastePct ?? 0)).toBe(30)
    expect(p?.needPct).toBe(100)
  })

  test('no plan without token totals or with under 1% used', () => {
    expect(planFiveHour({ used: 50, msLeft: H }, { used: 60, msLeft: 12 * H, tok: 1 })).toBe(null)
    expect(planFiveHour({ ...five, used: 0.5 }, { used: 60, msLeft: 12 * H, tok: 1 })).toBe(null)
  })
})

describe('freshest reading per window', () => {
  const five = (p: number) => ({ kind: 'five_hour', percentUsed: p })
  const week = (p: number) => ({ kind: 'seven_day', percentUsed: p })

  test('a newer reading from another chat wins each window it has', () => {
    const r = freshestLimits({ at: NOW - H, limits: [five(10), week(20)] }, [{ at: NOW - 60e3, limits: [week(35)] }])
    expect(r.limits).toEqual([five(10), week(35)])
    expect(r.borrowedAt).toBe(NOW - 60e3)
  })

  test('own reading wins when it is the newest', () => {
    const r = freshestLimits({ at: NOW, limits: [five(10), week(20)] }, [{ at: NOW - H, limits: [five(5), week(15)] }])
    expect(r.limits).toEqual([five(10), week(20)])
    expect(r.borrowedAt).toBe(undefined)
  })

  test('a chat with no reading of its own takes everything shared', () => {
    const r = freshestLimits({ at: 0, limits: [] }, [{ at: NOW - H, limits: [five(5)] }, { at: NOW - 60e3, limits: [week(15)] }])
    expect(r.limits).toEqual([five(5), week(15)])
    expect(r.borrowedAt).toBe(NOW - H)
  })
})
