// Background worker for usage-band (and extras/statusline.js): sums tokens from all
// Claude Code transcripts since each rate-limit window started, across every session,
// and reads the latest Codex rate-limit snapshot. Reads local files only; writes one
// JSON file of totals (no transcript content).
//
// Usage: node usage-scan.js [--out=<file>] [--codex=<CODEX_HOME>] <label>=<windowStartMs> ...
//   --out    default: $CLAUDE_CONFIG_DIR or ~/.claude, file statusline-usage.json
//   --codex  default: $CODEX_HOME or ~/.codex
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const opts = {};
const starts = {};
for (const a of process.argv.slice(2)) {
  const m = /^--(out|codex)=(.+)$/.exec(a);
  if (m) { opts[m[1]] = m[2]; continue; }
  const w = /^(\w{1,16})=(\d{1,16})$/.exec(a);
  if (w) starts[w[1]] = Number(w[2]);
}
if (!Object.keys(starts).length) process.exit(0);

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const OUT = path.resolve(opts.out || path.join(CLAUDE_DIR, 'statusline-usage.json'));
const ROOT = path.join(CLAUDE_DIR, 'projects');
const CODEX_HOME = opts.codex || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const earliest = Math.min(...Object.values(starts));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// Latest Codex rate-limit snapshot: newest token_count event across recent
// session logs. Only file tails are read — some Codex logs are hundreds of MB.
function codexLimits() {
  const root = path.join(CODEX_HOME, 'sessions');
  let files = [];
  try {
    for (const f of walk(root)) files.push([f, fs.statSync(f).mtimeMs]);
  } catch { return null; }
  files = files.sort((a, b) => b[1] - a[1]).slice(0, 8);
  let best = null;
  for (const [f] of files) {
    const size = fs.statSync(f).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let d;
      try { d = JSON.parse(lines[i]); } catch { continue; }
      const rl = d.payload?.rate_limits;
      if (!rl) continue;
      const t = Date.parse(d.timestamp);
      if (!best || t > best.at) best = { at: t, plan: rl.plan_type, windows: [rl.primary, rl.secondary].filter(Boolean) };
      break;
    }
  }
  return best;
}

(async () => {
  const totals = Object.fromEntries(Object.keys(starts).map((k) => [k, 0]));
  const seen = new Set();
  let files = [];
  try { files = [...walk(ROOT)]; } catch {}
  for (const file of files) {
    if (fs.statSync(file).mtimeMs < earliest) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const u = d.message?.usage;
      const id = d.message?.id || d.requestId;
      if (!u || !id || seen.has(id)) continue;
      seen.add(id);
      const t = Date.parse(d.timestamp);
      // Cache reads are excluded: they're cheap and would swamp the total.
      const tok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      for (const k in starts) if (t >= starts[k]) totals[k] += tok;
    }
  }
  let codex = null;
  try { codex = codexLimits(); } catch {}
  // Write then rename, so a reader never sees a half-written file.
  const tmp = `${OUT}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), starts, totals, codex }));
  fs.renameSync(tmp, OUT);
})();
