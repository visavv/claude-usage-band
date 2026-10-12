import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { ClaudeSnap, Meta, ModelReadings, ScanCache } from '../types'
import { barCells, buildView, family, fmtDur, freshestLimits, needsScan, pct, windowStarts } from './logic'
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
    // Every chat and model shares one quota, so the newest reading from any chat is the truth:
    // a chat you switch back to shows that instead of what it saw at its own last reply.
    const merged = freshestLimits({ at: ownAt, limits: own.rateLimits }, Object.values(shared))
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
        return <gui.Box flexDirection="column">{drawGui(gui, view, error, e.props.bodyColumns, await modelLine($))}</gui.Box>
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

type ModelLine = { borrowed: string }

// Says when the figures shown were borrowed from another chat's reading.
async function modelLine($: $): Promise<ModelLine> {
  const borrowedAt = (await read($, claude))?.borrowedAt
  return { borrowed: borrowedAt ? `latest reading ${fmtDur((await $.clock.now()) - borrowedAt)} ago` : '' }
}

type GUI = Pick<Elements['desktop'], 'Box' | 'Text' | 'Svg'>

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

const drawGui = (ui: GUI, view: View, error: string | null, columns: number, byModel: ModelLine) => {
  const { Box, Text } = ui
  const codex = view.rows.map(r => r.right).find(r => r?.kind === 'codex')
  const codexBars = view.rows.flatMap(r => (r.right?.kind === 'bar' ? [r.right] : []))
  const head = [view.model, view.folder, view.cost?.replace('session ', '')].filter(Boolean).join('  ·  ')
  const claudeDetail = (b: Bar) =>
    b.label === 'ctx'
      ? 'context window'
      : [b.tok && (b.cap ? `${b.tok} / ${b.cap}` : b.tok), b.resets ? `${b.resets} left` : 'reset'].filter(Boolean).join(' · ')
  const count = view.rows.filter(r => r.left).length + codexBars.length
  // All meters on one row when the band is wide enough for it, else a two-column grid.
  const oneRow = Math.floor((columns - GAP * (count - 1)) / Math.max(1, count))
  const width = oneRow >= 20 ? Math.min(oneRow, 30) : Math.max(20, Math.min(30, Math.floor((columns - GAP) / 2)))

  return [
    <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
      <Text color="gray">{head}</Text>
      {statusText(ui, view)}
      {byModel.borrowed && <Text color="gray" dimColor>{byModel.borrowed}</Text>}
      {view.plan && (
        <Text color={!view.plan.isFeasible ? 'red' : view.plan.needPct >= 75 ? 'yellow' : 'gray'}>{planText(view.plan)}</Text>
      )}
    </Box>,
    <Box flexDirection="row" flexWrap="wrap" columnGap={GAP}>
      {view.rows.flatMap(r => (r.left ? [Meter(ui, r.left, width, r.left.label, claudeDetail(r.left))] : []))}
      {codex?.kind === 'codex' &&
        codexBars.map(b =>
          Meter(ui, b, width, `◇ ${b.label}`, `Codex ${codex.seen} ago · ${b.resets ? `${b.resets} left` : 'reset'}`, 'green'),
        )}
    </Box>,
    ...(error ? [<Text color="yellow" dimColor>{`usage-band: ${error}`}</Text>] : []),
  ]
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
