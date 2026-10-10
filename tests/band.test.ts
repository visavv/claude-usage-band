import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const H = 3600e3
const CWD = 'C:\\work\\my-project'

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 140, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const CACHE = {
  at: NOW,
  starts: { '5h': NOW + 2.5 * H - 5 * H, '7d': NOW + 84 * H - 168 * H },
  totals: { '5h': 24_000, '7d': 1_200_000 },
  codex: { at: NOW - 9 * 60e3, plan: 'prolite', windows: [{ used_percent: 3, window_minutes: 10080, resets_at: (NOW + 84 * H) / 1000 }] },
}

test('band draws Claude and Codex rows on terminal and desktop', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - H,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 50, resetsAt: new Date(NOW + 2.5 * H).toISOString() },
        { kind: 'seven_day', percentUsed: 50, resetsAt: new Date(NOW + 84 * H).toISOString() },
      ],
      cost: { usd: 1.5 },
    },
  }))
  const MODELS = { fable: { at: NOW - 5 * 60e3, limits: [{ kind: 'seven_day', percentUsed: 50, resetsAt: new Date(NOW + 84 * H).toISOString() }] } }
  on('fs.read', (_, e) => ({ value: JSON.stringify(e.path.endsWith('usage-band-models.json') ? MODELS : CACHE) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.settle()

  const drawn = async (surface: 'terminal' | 'desktop') => {
    const ui = await $.ui.mount({ ...BAND, surface })
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    await ui.unmount()
    return text
  }

  // Claude is on pace; Codex is 3% into a half-elapsed 7d window, so it nudges.
  const NUDGE = '⚡ Codex: 97% of 7d quota unused — go build something!'

  const tui = await drawn('terminal')
  expect(tui).toContain(`◆ Opus 5.5 │ my-project │ session $1.50 │ ${NUDGE}`)
  expect(tui).toContain('used ≈ 24k of ~48k tok  resets in 2h30m')
  expect(tui).toContain('◇ Codex prolite · seen 9m ago')
  expect(tui).toContain('  3%  resets in 3d12h')

  const gui = await drawn('desktop')
  expect(gui).toContain(`Opus 5.5  ·  my-project  ·  $1.50${NUDGE}`)
  expect(gui).toContain('7d plan: max out every 5h window (18 windows left) · ~15% of the week still expires')
  expect(gui).toContain('ctx42%context window')
  expect(gui).toContain('5h50%24k / 48k · 2h30m left')
  expect(gui).toContain('7d50%1.2M / 2.4M · 3d12h left')
  expect(gui).toContain('◇ 7d3%Codex 9m ago · 3d12h left')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(4)
  await ui.unmount()
})

test('a chat with no reading of its own shows the shared one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  const MODELS = { fable: { at: NOW - 5 * 60e3, limits: [{ kind: 'seven_day', percentUsed: 15, resetsAt: new Date(NOW + 84 * H).toISOString() }] } }
  on('fs.read', (_, e) => ({ value: JSON.stringify(e.path.endsWith('usage-band-models.json') ? MODELS : CACHE) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  await ui.unmount()
  expect(text).toContain('latest reading 5m ago')
  expect(text).toContain('7d15%')
})

test('a headless run starts no scan, timer or load log', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const calls: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'headless' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('fs.read', (_, e) => (calls.push(`read ${e.path}`), { value: JSON.stringify(CACHE) }))
  on('fs.write', (_, e) => (calls.push(`write ${e.path}`), { value: undefined }))
  on('process.run', () => (calls.push('process.run'), { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })
  await clock.advance(60_000)
  expect(calls).toEqual([])
})

test('a newer reading from another chat replaces a stale one, and a redraw refreshes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let usageReads = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'old-chat' }))
  // This chat's own figures are from its last reply, hours ago: 10% of the week.
  on('session.usage', () => (usageReads++, {
    value: { startedAt: NOW - 5 * H, context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 10, resetsAt: new Date(NOW + 84 * H).toISOString() }] },
  }))
  // Another Opus chat saw 40% two minutes ago; a Fable chat's week is its own and must not leak in.
  const MODELS = { fable: { at: NOW - 60e3, limits: [{ kind: 'seven_day', percentUsed: 3, resetsAt: new Date(NOW + 84 * H).toISOString() }] }, opus: { at: NOW - 2 * 60e3, limits: [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(NOW + 84 * H).toISOString() }] } }
  on('fs.read', (_, e) => ({ value: JSON.stringify(e.path.endsWith('usage-band-models.json') ? MODELS : CACHE) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const draw = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    await ui.unmount()
    return text
  }
  const text = await draw()
  expect(text).toContain('7d40%')
  expect(text).toContain('latest reading 2m ago')

  const before = usageReads
  await clock.advance(6_000)
  await draw()
  await clock.advance(1)
  expect(usageReads).toBeGreaterThan(before)
})

test('an error left by a failed refresh clears once a refresh succeeds', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let failModel = true
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.model', () => (failModel ? { deny: 'not now' } : { value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('fs.read', () => ({ value: JSON.stringify(CACHE) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const draw = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    await ui.unmount()
    return text
  }
  expect(await draw()).toContain('usage-band: session.model/cwd')

  failModel = false
  await clock.advance(15_000)
  expect(await draw()).not.toContain('usage-band: session.model/cwd')
})

test('the desktop band switches between collapsed, compact and expanded by clicking', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', () => ({ value: CWD }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - H,
      context: { window: 200_000, tokens: 84_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 50, resetsAt: new Date(NOW + 2.5 * H).toISOString() },
        { kind: 'seven_day', percentUsed: 50, resetsAt: new Date(NOW + 84 * H).toISOString() },
      ],
    },
  }))
  const MODELS = { fable: { at: NOW - 60e3, limits: [{ kind: 'seven_day', percentUsed: 4, resetsAt: new Date(NOW + 84 * H).toISOString() }] } }
  on('fs.read', (_, e) => ({ value: JSON.stringify(e.path.endsWith('usage-band-models.json') ? MODELS : CACHE) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')

  // compact (default): meters, no planning rows
  expect(await ui.find({ key: 'more' })).toBeDefined()
  expect(await text()).not.toContain('by model')

  await ui.press({ key: 'more' })
  const full = await text()
  expect(full).toContain('5h plan')
  // this fixture's week is out of reach, so the plan row says how much will expire
  expect(full).toContain('18 windows before reset can hold only part of the week')
  expect(full).toContain('by model')
  expect(full).toContain('fable 7d 4% (1m ago)')
  expect(full).not.toContain('(1m ago) (1m ago)')
  expect(full).toContain('◆ Fable has 96% of its own week left — use Fable first (/model)')
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(5)

  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'expand' })).toBeDefined()
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(0)

  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 'more' })).toBeDefined()
  await ui.unmount()
})
