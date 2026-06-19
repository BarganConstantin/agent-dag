// Aggregates Codex token usage from ~/.codex/sessions rollout JSONL files.
// Unlike Claude, Codex has no CLI quota command — we derive usage from the
// actual session logs for 5h and 7d rolling windows.
import { readdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CODEX_HOME = process.env.CODEX_HOME
  ? process.env.CODEX_HOME
  : join(homedir(), ".codex");
const CODEX_SESSIONS_DIR = join(CODEX_HOME, "sessions");

// Cache results for 60s (lighter than Claude quota — reads more files)
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 60_000;

const WINDOW_5H_MS  = 5 * 60 * 60 * 1000;
const WINDOW_7D_MS  = 7 * 24 * 60 * 60 * 1000;

// Tail-read the last CHUNK bytes of a file, split on newlines, find the last
// token_count event. Returns the total_token_usage object or null.
const TAIL_CHUNK = 32_768; // 32 KB — enough for a few recent token_count lines

async function readLastTokenCount(filePath) {
  let fd;
  try {
    fd = await open(filePath, "r");
    const { size } = await fd.stat();
    if (size === 0) return null;
    const readSize = Math.min(size, TAIL_CHUNK);
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, size - readSize);
    const text = buf.toString("utf8");
    // Split into lines (may start mid-line — skip first if partial)
    const lines = text.split("\n");
    // Process from the end
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "event_msg" && obj.payload?.type === "token_count") {
          return obj.payload.info?.total_token_usage ?? null;
        }
      } catch { /* malformed — keep searching */ }
    }
  } catch { /* file gone or unreadable */ }
  finally { fd?.close().catch(() => {}); }
  return null;
}

// Parse session start time from rollout filename.
// Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
// The timestamp portion uses dashes instead of colons (Windows-safe).
function parseRolloutTime(filename) {
  // e.g. rollout-2026-06-17T12-39-01-019ed4f2-c821-...jsonl
  const m = filename.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/);
  if (!m) return null;
  // Replace the last two dashes in time part with colons
  const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3") + "Z";
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

// List rollout files whose start times fall within the given window.
async function listRolloutFiles(sinceMs) {
  const out = [];
  let years;
  try { years = (await readdir(CODEX_SESSIONS_DIR)).filter(d => /^\d{4}$/.test(d)).sort().reverse(); }
  catch { return out; }

  const nowMs = Date.now();
  for (const y of years) {
    // Skip years that can't possibly contain files within the window
    if (parseInt(y, 10) < new Date(nowMs - sinceMs - 86400000).getFullYear()) break;
    let months;
    try { months = (await readdir(join(CODEX_SESSIONS_DIR, y))).sort().reverse(); } catch { continue; }
    for (const m of months) {
      let days;
      try { days = (await readdir(join(CODEX_SESSIONS_DIR, y, m))).sort().reverse(); } catch { continue; }
      for (const d of days) {
        const dir = join(CODEX_SESSIONS_DIR, y, m, d);
        let files;
        try { files = await readdir(dir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const t = parseRolloutTime(f);
          if (t != null && nowMs - t <= sinceMs) {
            out.push({ path: join(dir, f), startMs: t });
          }
        }
      }
    }
  }
  return out;
}

function emptyWindow() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, totalTokens: 0, sessionCount: 0 };
}

export async function fetchCodexUsage({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const w5h  = emptyWindow();
  const w7d  = emptyWindow();

  try {
    // Need files from last 7 days (superset covers both windows)
    const files = await listRolloutFiles(WINDOW_7D_MS);

    await Promise.all(files.map(async ({ path, startMs }) => {
      const usage = await readLastTokenCount(path);
      if (!usage) return;

      const age = now - startMs;
      const in5h = age <= WINDOW_5H_MS;
      const in7d = age <= WINDOW_7D_MS; // always true here but explicit

      const inp   = usage.input_tokens          ?? 0;
      const out   = usage.output_tokens         ?? 0;
      const cacheR = usage.cached_input_tokens  ?? 0;
      const cacheC = 0; // rollout doesn't track cache creation separately
      const total = usage.total_tokens          ?? (inp + out);

      if (in5h) {
        w5h.inputTokens      += inp;
        w5h.outputTokens     += out;
        w5h.cacheReadTokens  += cacheR;
        w5h.cacheCreateTokens += cacheC;
        w5h.totalTokens      += total;
        w5h.sessionCount++;
      }
      if (in7d) {
        w7d.inputTokens      += inp;
        w7d.outputTokens     += out;
        w7d.cacheReadTokens  += cacheR;
        w7d.cacheCreateTokens += cacheC;
        w7d.totalTokens      += total;
        w7d.sessionCount++;
      }
    }));
  } catch (err) {
    console.error("agents-deck codex-usage: scan failed:", err?.message ?? err);
    const result = { ok: false, fetchedAt: now };
    _cache = result;
    _cacheAt = now;
    return result;
  }

  const result = { ok: true, window5h: w5h, window7d: w7d, fetchedAt: now };
  _cache = result;
  _cacheAt = now;
  return result;
}

export function invalidateCodexUsageCache() {
  _cache = null;
  _cacheAt = 0;
}
