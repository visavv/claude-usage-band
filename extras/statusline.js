// Optional Claude Code status line for the terminal, with the same figures as the band:
// context usage + plan rate-limit windows,
// with nudges to spend tokens before the window resets.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Plan-wide token totals come from usage-scan.js, run detached so rendering stays instant.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
const USAGE = path.join(CLAUDE_DIR, 'statusline-usage.json');
const SCAN = path.join(__dirname, '..', 'scripts', 'usage-scan.js');
function planUsage(starts) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(USAGE, 'utf8')); } catch {}
  const sameWindows = cache && Object.keys(starts).every((k) => Math.abs((cache.starts?.[k] ?? 0) - starts[k]) < 60e3);
  if (!cache || !sameWindows || Date.now() - cache.at > 60e3) {
    try {
      const args = Object.entries(starts).map(([k, v]) => `${k}=${Math.round(v)}`);
      spawn(process.execPath, [SCAN, `--out=${USAGE}`, ...args], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } catch {}
  }
  return cache || {};
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch {}

  const E = '\x1b[';
  const c = (code, s) => `${E}${code}m${s}${E}0m`;
  const dim = (s) => c('38;5;250', s);
  const sep = c('38;5;244', ' │ ');
  const track = (s) => c('38;5;238', s);
  const bold = (s) => c('1', s);

  // ticks: [{ at: 0-100, color }] drawn over the bar, e.g. pace and plan target.
  const bar = (pct, width, color, ticks = []) => {
    const p = Math.max(0, Math.min(100, pct));
    const full = Math.round((p / 100) * width);
    const cells = Array.from({ length: width }, (_, i) => (i < full ? c(color, '█') : track('░')));
    for (const t of ticks) {
      if (t.at == null) continue;
      const i = Math.min(width - 1, Math.max(0, Math.round((t.at / 100) * width) - (t.at >= 100 ? 1 : 0)));
      cells[i] = c(t.color, '│');
    }
    return cells.join('');
  };

  const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const n = Number(v);
    if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };

  const fmtDur = (ms) => {
    if (ms <= 0) return '0m';
    const m = Math.floor(ms / 60000);
    const dd = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (dd) return `${dd}d${h}h`;
    if (h) return `${h}h${String(mm).padStart(2, '0')}m`;
    return `${mm}m`;
  };

  // ── Line 1: model, folder, context window, cost ──
  const model = d.model?.display_name || d.model?.id || 'Claude';
  const dir = path.basename(d.workspace?.current_dir || d.cwd || '');
  const cw = d.context_window || {};
  let ctxPct = cw.used_percentage;
  if (ctxPct == null && cw.current_usage && cw.context_window_size) {
    const u = cw.current_usage;
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    ctxPct = (used / cw.context_window_size) * 100;
  }
  // Header line, then one aligned row per bar so they stack vertically.
  const BAR = 20;
  const pct = (n) => `${String(Math.round(n)).padStart(3)}%`;
  const row = (label, p, col, extra = '', ticks) =>
    `${bold(label.padEnd(4))}${bar(p, BAR, col, ticks)} ${pct(p)}${extra}`;

  const head = [c('1;36', `◆ ${model}`)];
  if (dir) head.push(dim(dir));
  const cost = d.cost?.total_cost_usd;
  if (cost != null) head.push(dim(`session $${cost.toFixed(2)}`));
  const lines = [head.join(sep)];

  if (ctxPct != null) {
    const col = ctxPct >= 80 ? '31' : ctxPct >= 60 ? '33' : '32';
    lines.push(row('ctx', ctxPct, col, dim('  context')));
  }

  // ── Rate-limit windows with "use it or lose it" nudges ──
  const rl = d.rate_limits || {};
  const windows = [
    ['5h', rl.five_hour, 5 * 3600e3],
    ['7d', rl.seven_day, 7 * 86400e3],
  ];
  const starts = {};
  for (const [label, w, len] of windows) {
    const r = w && toMs(w.resets_at ?? w.reset_at);
    if (r) starts[label] = r - len;
  }
  const scan = Object.keys(starts).length ? planUsage(starts) : {};
  const sameWindows = Object.keys(starts).every((k) => Math.abs((scan.starts?.[k] ?? 0) - starts[k]) < 60e3);
  const planTok = sameWindows ? scan.totals || {} : {};
  let shown = 0;
  let nudge = null;
  const now = Date.now();

  // On pace = used share roughly tracks elapsed share of the window.
  // Behind pace = tokens that will likely expire unused.
  const analyze = (label, usedPct, resetsAt, len, who) => {
    let used = Number(usedPct ?? 0);
    const reset = toMs(resetsAt);
    let msLeft = reset ? reset - now : null;
    // A snapshot older than its window means the window has already reset.
    if (msLeft != null && msLeft <= 0) { used = 0; msLeft = null; }
    const left = Math.max(0, 100 - used);
    const elapsedFrac = msLeft != null ? Math.min(1, Math.max(0, 1 - msLeft / len)) : null;
    const behind = elapsedFrac != null ? elapsedFrac * 100 - used : 0;
    let col = '32';
    if (used >= 90) col = '31';
    else if (behind > 25) col = '35';
    else if (behind > 10) col = '33';

    if (msLeft != null && left >= 20) {
      const urgentWindow = label === '5h' ? msLeft < 90 * 60e3 : msLeft < 36 * 3600e3;
      const score = behind + (urgentWindow ? 50 : 0);
      if ((behind > 10 || urgentWindow) && (!nudge || score > nudge.score)) {
        const msg = urgentWindow
          ? `🔥 ${who}${left.toFixed(0)}% of ${label} quota expires in ${fmtDur(msLeft)} — USE IT!`
          : `⚡ ${who}${left.toFixed(0)}% of ${label} quota unused — go build something!`;
        nudge = { score, msg, urgent: urgentWindow };
      }
    }
    return { used, left, msLeft, col, elapsed: elapsedFrac != null ? elapsedFrac * 100 : null };
  };

  const claudeLeft = {};
  const rowKeys = lines.map(() => null);
  const stats = {};
  for (const [label, w, len] of windows) {
    if (!w) continue;
    const a = analyze(label, w.used_percentage ?? w.utilization, w.resets_at ?? w.reset_at, len, '');
    claudeLeft[label] = a.left;
    stats[label] = { ...a, tok: planTok[label] };
  }

  // ── 7d plan: how hard the remaining 5h windows must be used so weekly quota doesn't expire ──
  // A full 5h window is worth cap5 ÷ cap7 of the week (capacities extrapolated from tokens ÷ used%).
  let plan = null;
  const s5 = stats['5h'], s7 = stats['7d'];
  if (s5 && s7 && s7.msLeft != null && s5.tok != null && s7.tok != null && s5.used >= 1 && s7.used >= 1) {
    const perWindow = ((s5.tok / s5.used) / (s7.tok / s7.used)) * 100;
    const left7 = Math.max(0, 100 - s7.used);
    const running = s5.msLeft != null;
    const current = running ? ((100 - s5.used) / 100) * perWindow : 0;
    const after = s7.msLeft - (s5.msLeft ?? 0);
    const later = after > 0 ? Math.ceil(after / (5 * 3600e3)) : 0;
    const available = current + later * perWindow;
    if (perWindow > 0 && available > 0) {
      const share = Math.min(1, left7 / available);
      plan = {
        windows: (running ? 1 : 0) + later,
        needPct: share * 100,
        target: running ? s5.used + share * (100 - s5.used) : null,
        feasible: left7 <= available,
        wastePct: Math.max(0, left7 - available),
      };
    }
  }

  for (const [label, w] of windows) {
    if (!w) continue;
    const { used, msLeft, col, elapsed } = stats[label];
    // Grey tick = on-pace position; orange tick on 5h = where to end this window per the 7d plan.
    const ticks = [{ at: elapsed, color: '38;5;250' }];
    if (label === '5h' && plan?.target != null) ticks.push({ at: plan.target, color: '38;5;214' });

    const resetTxt = msLeft != null ? `  resets in ${fmtDur(msLeft)}` : '';
    // Total capacity is extrapolated: tokens spent so far ÷ fraction used.
    const tok = planTok[label];
    let tokTxt = '';
    if (tok != null) {
      tokTxt = ` ≈ ${fmtTok(tok)}`;
      if (used >= 1) tokTxt += ` of ~${fmtTok((tok / used) * 100)} tok`;
    }
    lines.push(row(label, used, col, dim(`  used${tokTxt}${resetTxt}`), ticks));
    rowKeys.push(label);
    shown++;
  }

  // ── Codex column, right of the Claude bars, rows matched by window length ──
  const cx = scan.codex;
  const right = lines.map(() => '');
  if (cx) {
    const CBAR = 12;
    const ctxRow = rowKeys.length > 1 ? 1 : 0;
    right[ctxRow] = c('1;32', '◇ Codex') + dim(` ${cx.plan || ''} · seen ${fmtDur(now - cx.at)} ago`);
    for (const w of cx.windows || []) {
      const label = w.window_minutes === 300 ? '5h' : w.window_minutes === 10080 ? '7d' : `${w.window_minutes}m`;
      const a = analyze(label, w.used_percent, w.resets_at, w.window_minutes * 60e3, 'Codex: ');
      // Out of Claude quota but Codex has room → suggest switching.
      if ((claudeLeft[label] ?? 100) < 10 && a.left >= 20 && !nudge?.urgent)
        nudge = { score: 999, msg: `↪ Claude ${label} nearly out — switch to Codex (${a.left.toFixed(0)}% left)`, urgent: false };
      let i = rowKeys.indexOf(label);
      if (i < 0) { lines.push(''); rowKeys.push(label); right.push(''); i = lines.length - 1; }
      right[i] = `${bold(label.padEnd(3))}${bar(a.used, CBAR, a.col, [{ at: a.elapsed, color: '38;5;250' }])} ${pct(a.used)}` +
        dim(a.msLeft != null ? `  resets in ${fmtDur(a.msLeft)}` : '  reset');
    }
  }

  // Status/warning goes on the header line, after the cost.
  if (!shown) head.push(dim('quota: waiting for first API response…'));
  else if (nudge) {
    // Bold white on red when urgent so it's hard to ignore.
    head.push(nudge.urgent ? c('1;97;41', ` ${nudge.msg} `) : c('1;35', nudge.msg));
  } else head.push(c('32', '✓ on pace'));
  lines[0] = head.join(sep);
  if (plan) {
    const w = `${plan.windows} window${plan.windows === 1 ? '' : 's'} left`;
    let txt;
    if (!plan.feasible) txt = c('31', `7d plan: max out every 5h window (${w}) · ~${Math.round(plan.wastePct)}% of the week still expires`);
    else if (plan.needPct >= 60) txt = c('33', `7d plan: use ~${Math.round(plan.needPct)}% of each 5h window (${w})` + (plan.target != null ? ` · end this 5h at ≥${Math.round(plan.target)}%` : ''));
    else txt = c('32', `7d plan: ~${Math.round(plan.needPct)}% of each 5h window is enough (${w})`);
    lines.splice(1, 0, txt);
    right.splice(1, 0, '');
  }

  // Pad the Claude column (rows 1+) to a common width so Codex lines up on the right.
  const vis = (s) => s.replace(/\[[0-9;]*m/g, '').length;
  const width = Math.max(0, ...lines.slice(1).map(vis));
  for (let i = 1; i < lines.length; i++)
    if (right[i]) lines[i] = lines[i] + ' '.repeat(width - vis(lines[i])) + c('38;5;244', '  ┃ ') + right[i];

  process.stdout.write(lines.join('\n'));
});
