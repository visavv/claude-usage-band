import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { ClaudeSnap, Meta, ModelReadings, ScanCache, ViewMode } from '../types'
import { barCells, buildView, fableHint, family, fmtDur, freshestLimits, modelUse, needsScan, pct, windowStarts } from './logic'
import type { Bar, Plan, View } from './logic'

const PANE = 'usage-band'

type Paths = { cache: string; models: string; scan: string; codexHome: string }
let paths: Paths | null = null

// Everything lives in the Claude config folder ($CLAUDE_CONFIG_DIR, else ~/.claude), so the mod
// works for any user; the scanner ships with the plugin.
async function where($: $): Promise<Paths> {
  if (paths) return paths
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const dir = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`).replace(/\\/g, '/')
  paths = {
    // Shared with the optional CLI status line in extras/, which reads and refreshes the same file.
    cache: `${dir}/statusline-usage.json`,
    models: `${dir}/usage-band-models.json`,
    scan: `${$.plugin.root.replace(/\\/g, '/')}/scripts/usage-scan.js`,
    codexHome: ((await $.env.get('CODEX_HOME')) ?? `${home}/.codex`).replace(/\\/g, '/'),
  }
  return paths
}

const claude = atom({ plugin: 'usage-band', key: 'claude' } as const, null)
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, null)
const meta = atom({ plugin: 'usage-band', key: 'meta' } as const, { model: 'Claude', folder: '' })
const clockNow = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)
const toasted = atom({ plugin: 'usage-band', key: 'toasted' } as const, [])
const models = atom({ plugin: 'usage-band', key: 'models' } as const, {})
const viewMode = atom({ plugin: 'usage-band', key: 'view' } as const, 'compact')
const scanError = atom({ plugin: 'usage-band', key: 'scanError' } as const, null)

type $ = EngineInterface

const snap = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): ClaudeSnap => ({
  contextPercent: u.context.percent ?? null,
  rateLimits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  costUsd: u.cost?.usd ?? null,
})

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

let isScanning = false
let ticker: { cancel: () => void } | null = null
// When this chat last got a reading of its own (0: none since load).
let ownAt = 0
// When a drawing or an attach last asked for a refresh; keeps redraws from flooding it.
let lastKick = 0
// Set by ensureTicker; what a drawing calls to ask for a refresh (null until a non-render event ran).
let refreshSoon: (() => void) | null = null

async function readCache($: $) {
  try {
    const parsed = JSON.parse(await $.fs.read((await where($)).cache)) as ScanCache
    await update($, cache, () => parsed)
    await update($, scanError, err => (err?.startsWith('read ') ? null : err))
  } catch (err) {
    const { cache: file } = await where($)
    await update($, scanError, () => `read ${file}: ${errText(err)}`)
  }
}

async function readModels($: $): Promise<ModelReadings> {
  let parsed: ModelReadings = {}
  try {
    parsed = JSON.parse(await $.fs.read((await where($)).models)) as ModelReadings
  } catch {
    // Not written yet.
  }
  await update($, models, () => parsed)
  return parsed
}

// A turn's reading belongs to the model that answered it; every session shares the file.
async function recordModel($: $, limits: ClaudeSnap['rateLimits']) {
  if (!limits.length) return
  try {
    const name = family(await $.session.model())
    const next = { ...(await readModels($)), [name]: { at: await $.clock.now(), limits } }
    await $.fs.write((await where($)).models, JSON.stringify(next))
    await update($, models, () => next)
  } catch (err) {
    const { models: file } = await where($)
    await update($, scanError, () => `write ${file}: ${errText(err)}`)
  }
}

// Refreshes now unless one ran in the last few seconds; for redraws and window attaches.
async function kick($: $) {
  const now = await $.clock.now()
  if (now - lastKick < 5_000) return
  lastKick = now
  await refresh($)
}

// Keeps the band fresh between turns. Started from whichever hook runs first, so a session
// that missed session.start (or whose start failed) still ticks.
function ensureTicker($: $) {
  if (ticker) return
  ticker = $.clock.every(15_000, () => void refresh($))
  // Bound to this event's $, never a drawing's: the engine refuses writes that a ui.render started.
  refreshSoon = () => void $.clock.after(0, () => void kick($))
}

async function readMeta($: $) {
  const [model, cwd] = await Promise.all([$.session.model(), $.session.cwd()])
  const next: Meta = { model, folder: cwd.split(/[\\/]/).filter(Boolean).pop() ?? '' }
  await update($, meta, () => next)
}

// Runs usage-scan.js the way statusline.js does, without holding anything up.
async function maybeScan($: $) {
  if (isScanning) return
  const starts = windowStarts((await read($, claude))?.rateLimits ?? [])
  if (!needsScan(await read($, cache), starts, await $.clock.now())) return
  isScanning = true
  const p = await where($)
  // No shell: argv only, and every argument is a label and a whole number.
  const argv = ['node', p.scan, `--out=${p.cache}`, `--codex=${p.codexHome}`, ...Object.entries(starts).map(([k, v]) => `${k}=${Math.round(v)}`)]
  void $.process.run(argv, { timeoutMs: 120_000 })
    .then(async r => {
      const failure = r.exitCode === 0 ? null : `usage-scan.js exited ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`
      await update($, scanError, () => failure)
    })
    .catch(err => update($, scanError, () => `run node usage-scan.js: ${errText(err)}`))
    .finally(async () => {
      isScanning = false
      await readCache($)
      await check($)
    })
}

// Toasts each window once, the first time it turns urgent.
async function check($: $) {
  const view = buildView(await read($, claude), await read($, cache), await read($, meta), await $.clock.now())
  const seen = await read($, toasted)
  const fresh = view.urgent.filter(u => !seen.includes(u.key))
  const hint = fableHint(await read($, models), (await read($, meta)).model, await $.clock.now())
  if (hint && !seen.includes('fable-hint')) {
    $.ui.toast(`◆ ${hint}`, { timeoutMs: 10_000 })
    await update($, toasted, list => [...list, 'fable-hint'].slice(-50))
  }
  if (!fresh.length) return
  for (const u of fresh) $.ui.toast(u.text, { timeoutMs: 8000 })
  await update($, toasted, list => [...list, ...fresh.map(u => u.key)].slice(-50))
}

// Re-reads everything; the `now` write redraws countdowns even when nothing else moved.
// Each step is caught on its own so one refusal can't hide the others; failures show on the band.
async function refresh($: $) {
  const errors: string[] = []
  try {
    await readMeta($)
  } catch (err) {
    errors.push(`session.model/cwd: ${errText(err)}`)
  }
  const shared = await readModels($)
  try {
    const own = snap(await $.session.usage())
    // Chats on the same model family share its quota, so the newest reading any of them saw is the
    // truth: a chat you switch back to shows that, not what it saw at its own last reply. Families
    // are kept apart because Fable has a weekly quota of its own.
    const same = shared[family((await read($, meta)).model)]
    const merged = freshestLimits({ at: ownAt, limits: own.rateLimits }, same ? [same] : [])
    const next: ClaudeSnap = { ...own, rateLimits: merged.limits, borrowedAt: merged.borrowedAt }
    await update($, claude, () => next)
  } catch (err) {
    errors.push(`session.usage: ${errText(err)}`)
  }
  await readCache($)
  try {
    const now = await $.clock.now()
    await update($, clockNow, () => now)
    await maybeScan($)
    await check($)
  } catch (err) {
    errors.push(`refresh: ${errText(err)}`)
  }
  const mine = /^(session\.|refresh:)/
  await update($, scanError, err => (errors.length ? errors.join(' · ') : err && mine.test(err) ? null : err))
}

// From a Button's onPress (a handler, so it may write): this chat redraws, and new chats start in it.
async function setView($: $, mode: ViewMode) {
  await update($, viewMode, () => mode)
  await $.store.set('view', mode).catch(() => undefined)
}

// Reads every atom the drawing depends on (the `now` tick included), so a write to any redraws.
async function currentView($: $): Promise<View> {
  await read($, clockNow)
  return buildView(await read($, claude), await read($, cache), await read($, meta), await $.clock.now())
}

export const register: Register = on => {
  // Headless runs (`claude -p`, scripts, tests) draw nothing: no scans, timers or toasts there.
  let isHeadless = false

  on('session.start', async ($, e, next) => {
    isHeadless = !e.isInteractive
    if (isHeadless) {
      return next(e)
    }
    // Figures first, so the band fills in as soon as it can.
    void refresh($)
    // The view the person last picked, in any chat.
    const saved = await $.store.get('view').catch(() => undefined)
    if (saved === 'mini' || saved === 'compact' || saved === 'full') await update($, viewMode, () => saved)
    // /usage is a built-in, so the command is /quota. A refusal must not stop the band starting.
    try {
      await $.command.register({
        name: 'quota',
        description: 'Claude + Codex quota pane (/quota hide | show to toggle the band)',
        argumentHint: '[hide|show]',
      })
    } catch (err) {
      await update($, scanError, () => `command.register: ${errText(err)}`)
    }
    ticker?.cancel()
    ticker = null
    ensureTicker($)

    return next(e)
  })

  // Fallback in case session.start's refresh never landed: every prompt re-reads.
  on('prompt.submit', async ($, e, next) => {
    if (isHeadless) {
      return next(e)
    }
    ensureTicker($)
    void refresh($)

    return next(e)
  })

  on('session.measure', async ($, e: SessionMeasureInput, next) => {
    // Even a headless run's reading is worth sharing with the open chats; nothing else runs there.
    await readMeta($)
    if (!isHeadless && e.rateLimits.length) ownAt = await $.clock.now()
    await recordModel($, snap(e).rateLimits)
    if (isHeadless) {
      return next(e)
    }
    ensureTicker($)
    await update($, claude, () => snap(e))
    void maybeScan($).then(() => check($))

    return next(e)
  })

  // The desktop attached to this chat (opened it, or came back to it): re-read at once.
  on('session.attach', async ($, e, next) => {
    if (!isHeadless) void kick($)

    return next(e)
  })

  on('command.run', { command: 'quota' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
      return { text: `Usage band ${arg === 'hide' ? 'hidden' : 'shown'}.` }
    }
    await $.ui.open({ id: PANE, title: 'Usage' })
    void refresh($)

    return { text: 'Usage pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) {
      return next(e)
    }
    // A drawing may not write state, so the refresh runs on the clock right after it.
    if ((await $.clock.now()) - lastKick >= 5_000) refreshSoon?.()
    const ui = $.ui.resolve(e)
    // A failure while drawing must show as a line, never as a missing band.
    try {
      const view = await currentView($)
      const error = await read($, scanError)
      // The terminal keeps the CLI status line's layout; the desktop gets drawn meters.
      if (e.surface === 'desktop') {
        const gui = $.ui.resolve(e)
        return <gui.Box flexDirection="column">{drawGui(gui, view, error, e.props.bodyColumns, await modelLine($), await read($, viewMode), (mode: ViewMode) => setView($, mode))}</gui.Box>
      }

      return <ui.Box flexDirection="column">{drawView(ui, view, error)}</ui.Box>
    } catch (err) {
      return <ui.Text color="yellow">{`usage-band could not draw: ${errText(err)}`}</ui.Text>
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await currentView($)
    const hidden = await read($, isHidden)
    const ui = $.ui.resolve(e)

    return (
      <ui.Box flexDirection="column">
        {drawView(ui, view, await read($, scanError))}
        <ui.Box marginTop={1}>
          <ui.Button
            key="toggle"
            hotkey="h"
            label={hidden ? 'Show band' : 'Hide band'}
            onPress={() => update($, isHidden, h => !h)}
          />
        </ui.Box>
      </ui.Box>
    )
  })
}

type UI = Pick<Elements['terminal'], 'Box' | 'Text'>

const SEP = ' │ '

const BarRow = (ui: UI, b: Bar) => {
  const { full, track } = barCells(b)
  return [
    <ui.Text bold>{b.label.padEnd(b.width === 20 ? 4 : 3)}</ui.Text>,
    <ui.Text color={b.color}>{full}</ui.Text>,
    <ui.Text color="gray" dimColor>{track}</ui.Text>,
    <ui.Text> {pct(b.used)}</ui.Text>,
    <ui.Text color="gray">{b.extra}</ui.Text>,
  ]
}

type ModelLine = { borrowed: string; hint: string | null; families: ReturnType<typeof modelUse>; current: string }

// Says when the figures shown were borrowed from another chat's reading.
async function modelLine($: $): Promise<ModelLine> {
  const borrowedAt = (await read($, claude))?.borrowedAt
  const now = await $.clock.now()
  const all = await read($, models)
  const current = family((await read($, meta)).model)
  return {
    borrowed: borrowedAt ? `latest reading ${fmtDur(now - borrowedAt)} ago` : '',
    hint: fableHint(all, current, now),
    families: modelUse(all, now),
    current,
  }
}

type GUI = Pick<Elements['desktop'], 'Box' | 'Text' | 'Svg' | 'Button'>

const FILL: Record<Bar['color'], string> = { green: '#5fae7b', yellow: '#d9a441', red: '#e5534b', magenta: '#c86fd0' }
const METER = { width: 84, height: 12 }
const GAP = 3

// A rounded meter as an image: the fill, and a tick where on-pace usage would be.
const meterSvg = (b: Bar): string => {
  const { width: w, height: h } = METER
  const used = Math.max(0, Math.min(100, b.used))
  const fill = used > 0 ? Math.max(4, (used / 100) * w) : 0
  const tick = b.elapsed != null ? Math.max(1, Math.min(w - 1, (b.elapsed / 100) * w)) : null
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect y="3" width="${w}" height="6" rx="3" fill="#888" fill-opacity="0.3"/>` +
    (fill ? `<rect y="3" width="${fill.toFixed(1)}" height="6" rx="3" fill="${FILL[b.color]}"/>` : '') +
    (tick != null ? `<rect x="${(tick - 1).toFixed(1)}" y="0" width="2" height="${h}" rx="1" fill="#999"/>` : '') +
    // Orange mark: where this 5h window should end to keep the 7d plan.
    (b.target != null
      ? `<rect x="${(Math.max(1, Math.min(w - 1, (b.target / 100) * w)) - 1).toFixed(1)}" y="0" width="2" height="${h}" rx="1" fill="#d97757"/>`
      : '') +
    `</svg>`
  )
}

// One quota: `5h [meter] 24%` over its detail line, in a fixed-width cell so cells line up.
const Meter = (ui: GUI, b: Bar, width: number, label: string, detail: string, labelColor?: string) => (
  <ui.Box flexDirection="column" width={width} flexShrink={0}>
    <ui.Box flexDirection="row" alignItems="center" columnGap={1}>
      <ui.Box width={4} flexShrink={0}>
        <ui.Text bold color={labelColor}>{label}</ui.Text>
      </ui.Box>
      <ui.Svg source={meterSvg(b)} alt={`${label} ${Math.round(b.used)}% used`} width={METER.width} height={METER.height} />
      <ui.Text bold>{`${Math.round(b.used)}%`}</ui.Text>
    </ui.Box>
    <ui.Text color="gray" wrap="truncate-end">{detail}</ui.Text>
  </ui.Box>
)

const planText = (p: Plan): string => {
  const n = `${p.windows} window${p.windows === 1 ? '' : 's'} left`
  return p.isFeasible
    ? `7d plan: use ~${Math.round(p.needPct)}% of each 5h window (${n})`
    : `7d plan: max out every 5h window (${n}) · ~${Math.round(p.wastePct)}% of the week still expires`
}

// One pip per 5h window left before the weekly reset; filled = full windows' worth of week to spend.
const pipsSvg = (windows: number, full: number, isFeasible: boolean): string => {
  const n = Math.max(1, Math.min(40, windows))
  const w = 9
  const gap = 3
  const h = 12
  const cells = Array.from({ length: n }, (_, i) => {
    const x = i * (w + gap)
    const fill = isFeasible ? Math.max(0, Math.min(1, full - i)) : 1
    const color = isFeasible ? '#d97757' : '#e5534b'
    return (
      `<rect x="${x}" y="1" width="${w}" height="${h - 2}" rx="2" fill="#888" fill-opacity="0.3"/>` +
      (fill > 0 ? `<rect x="${x}" y="1" width="${(w * fill).toFixed(1)}" height="${h - 2}" rx="2" fill="${color}"/>` : '')
    )
  })
  const width = n * (w + gap) - gap
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${cells.join('')}</svg>`
}

const ViewButtons = (ui: GUI, mode: ViewMode, pick: (mode: ViewMode) => void) => [
  mode === 'full' ? (
    <ui.Button key="less" label="Less" plain dimColor onPress={() => pick('compact')} />
  ) : (
    <ui.Button key="more" label="More" plain dimColor onPress={() => pick('full')} />
  ),
  <ui.Button key="collapse" label="Collapse" plain dimColor onPress={() => pick('mini')} />,
]

const drawGui = (
  ui: GUI,
  view: View,
  error: string | null,
  columns: number,
  byModel: ModelLine,
  mode: ViewMode,
  pick: (mode: ViewMode) => void,
) => {
  const { Box, Text, Svg } = ui
  const codex = view.rows.map(r => r.right).find(r => r?.kind === 'codex')
  const codexBars = view.rows.flatMap(r => (r.right?.kind === 'bar' ? [r.right] : []))

  // Collapsed: one line, the figures that matter, a click away from the rest.
  if (mode === 'mini') {
    const pcts = view.rows
      .flatMap(r => (r.left && r.left.label !== 'ctx' ? [`${r.left.label} ${Math.round(r.left.used)}%`] : []))
      .join(' · ')
    return [
      <Box flexDirection="row" columnGap={GAP}>
        <ui.Button key="expand" label={`◆ ${pcts || 'usage'}  ▸`} plain dimColor onPress={() => pick('compact')} />
        {(view.status.kind === 'urgent' || view.status.kind === 'nudge') && statusText(ui, view)}
      </Box>,
    ]
  }

  const head = [view.model, view.folder, view.cost?.replace('session ', '')].filter(Boolean).join('  ·  ')
  const claudeDetail = (b: Bar) =>
    b.label === 'ctx'
      ? 'context window'
      : [b.tok && (b.cap ? `${b.tok} / ${b.cap}` : b.tok), b.resets ? `${b.resets} left` : 'reset'].filter(Boolean).join(' · ')
  const count = view.rows.filter(r => r.left).length + codexBars.length
  // All meters on one row when the band is wide enough for it, else a two-column grid.
  const oneRow = Math.floor((columns - GAP * (count - 1)) / Math.max(1, count))
  const width = oneRow >= 20 ? Math.min(oneRow, 30) : Math.max(20, Math.min(30, Math.floor((columns - GAP) / 2)))

  const rows = [
    <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
      <Text color="gray">{head}</Text>
      {statusText(ui, view)}
      {byModel.borrowed && <Text color="gray" dimColor>{byModel.borrowed}</Text>}
      {mode === 'compact' && view.plan && (
        <Text color={!view.plan.isFeasible ? 'red' : view.plan.needPct >= 75 ? 'yellow' : 'gray'}>{planText(view.plan)}</Text>
      )}
      {ViewButtons(ui, mode, pick)}
    </Box>,
    <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
      {view.rows.flatMap(r => (r.left ? [Meter(ui, r.left, width, r.left.label, claudeDetail(r.left))] : []))}
      {codex?.kind === 'codex' &&
        codexBars.map(b =>
          Meter(ui, b, width, `◇ ${b.label}`, `Codex ${codex.seen} ago · ${b.resets ? `${b.resets} left` : 'reset'}`, 'green'),
        )}
    </Box>,
  ]

  if (mode === 'full') {
    const plan = view.plan
    if (plan) {
      const need = plan.isFeasible
        ? `${plan.fullWindows.toFixed(1)} full 5h windows of week left to spend · ${plan.windows} windows before reset`
        : `${plan.windows} windows before reset can hold only part of the week · ~${Math.round(plan.wastePct)}% will expire`
      rows.push(
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Box width={9} flexShrink={0}>
            <Text bold>5h plan</Text>
          </Box>
          <Svg
            source={pipsSvg(plan.windows, plan.fullWindows, plan.isFeasible)}
            alt={`${plan.fullWindows.toFixed(1)} of ${plan.windows} windows`}
            height={12}
          />
          <Text color={!plan.isFeasible ? 'red' : plan.needPct >= 75 ? 'yellow' : 'gray'} wrap="truncate-end">{`  ${need}`}</Text>
        </Box>,
      )
      rows.push(
        <Text color="gray" wrap="truncate-end">{`          ${planText(plan).replace('7d plan: ', 'to use the whole week: ')}`}</Text>,
      )
    }
    if (byModel.families.length) {
      rows.push(
        <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
          <Box width={9} flexShrink={0}>
            <Text bold>by model</Text>
          </Box>
          {byModel.families.map(m => (
            <Box flexDirection="row" flexShrink={0}>
              <Text color={m.family === 'fable' ? 'magenta' : undefined} bold={m.family === byModel.current}>
                {`${m.family} 7d ${Math.round(m.used)}%${m.five != null ? ` · 5h ${Math.round(m.five)}%` : ''}`}
              </Text>
              <Text color="gray">{` (${m.age} ago)`}</Text>
            </Box>
          ))}
        </Box>,
      )
    }
    if (byModel.hint) rows.push(<Text bold color="magenta">{`◆ ${byModel.hint}`}</Text>)
  }

  if (error) rows.push(<Text color="yellow" dimColor>{`usage-band: ${error}`}</Text>)
  return rows
}

const statusText = (ui: UI, view: View) => {
  const { Text } = ui
  const s = view.status
  return s.kind === 'urgent' ? (
      <Text bold color="white" backgroundColor="red">{` ${s.text} `}</Text>
    ) : s.kind === 'nudge' ? (
      <Text bold color="magenta">{s.text}</Text>
    ) : s.kind === 'ok' ? (
      <Text color="green">{s.text}</Text>
    ) : (
      <Text color="gray">{s.text}</Text>
    )
}

const drawView = (ui: UI, view: View, error: string | null) => {
  const { Box, Text } = ui
  const status = statusText(ui, view)

  const head = [<Text bold color="cyan">{`◆ ${view.model}`}</Text>]
  for (const part of [view.folder, view.cost]) {
    if (part) head.push(<Text color="gray">{SEP}</Text>, <Text color="gray">{part}</Text>)
  }
  head.push(<Text color="gray">{SEP}</Text>, status)

  return [
    <Box flexDirection="row" flexWrap="wrap">{head}</Box>,
    ...view.rows.map(row => (
      <Box flexDirection="row">
        <Box flexDirection="row" width={view.leftWidth} flexShrink={0}>
          {row.left ? BarRow(ui, row.left) : <Text> </Text>}
        </Box>
        {row.right && <Text color="gray">{'  ┃ '}</Text>}
        {row.right?.kind === 'codex' && [
          <Text bold color="green">◇ Codex</Text>,
          <Text color="gray">{` ${row.right.plan} · seen ${row.right.seen} ago`}</Text>,
        ]}
        {row.right?.kind === 'bar' && BarRow(ui, row.right)}
      </Box>
    )),
    ...(error ? [<Text color="yellow" dimColor>{`usage-band: ${error}`}</Text>] : []),
  ]
}
