// Fetches Claude rate-limit quota by running `claude --print "/usage"`.
// Caches the result for 2 minutes so the UI can poll without hammering the CLI.
// Degrades gracefully — returns {ok:false} if claude isn't in PATH or the
// non-interactive flag doesn't surface quota data (older CLI versions).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 120_000; // 2 min — quota resets are not sub-second

// Strip ANSI escape sequences so regexes work on raw text.
function stripAnsi(s) {
  return s
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][AB012]/g, "");
}

/**
 * Parse Claude `/usage` output.
 * Handles both the compact single-line format and the table format.
 *
 * Patterns seen across Claude Code versions:
 *   "Session (5h)   ██████░░  60%  resets in 1h 20m"
 *   "session_5h: 60%  resets in 1h 20m"
 *   "5-hour: 60%"
 *   "Weekly (7d)    ████░░░░  40%  resets Thu"
 *   "week_all: 40%"
 */
function parseUsageText(raw) {
  const text = stripAnsi(raw);
  const result = {};

  // ── 5-hour window ───────────────────────────────────────────────────────
  const fh = text.match(
    /(?:session(?:_5h)?|5.?h(?:our)?)[^\n]*?(\d{1,3})\s*%/i
  ) || text.match(/(\d{1,3})\s*%[^\n]*(?:session|5.?h(?:our)?)/i);
  if (fh) result.session5hPct = Math.min(100, parseInt(fh[1], 10));

  // Reset time for 5h window (text immediately after the 5h % on the same line)
  const fhLine = text.match(
    /(?:session(?:_5h)?|5.?h(?:our)?)[^\n]*/i
  )?.[0] ?? "";
  const fhReset = fhLine.match(/resets?\s+(?:in\s+)?([^\n,|]+)/i)?.[1]?.trim();
  if (fhReset) result.session5hReset = fhReset;

  // ── 7-day window ────────────────────────────────────────────────────────
  const wd = text.match(
    /(?:week(?:ly)?(?:_all(?:_models)?)?|7.?d(?:ay)?)[^\n]*?(\d{1,3})\s*%/i
  ) || text.match(/(\d{1,3})\s*%[^\n]*(?:week(?:ly)?|7.?d(?:ay)?)/i);
  if (wd) result.week7dPct = Math.min(100, parseInt(wd[1], 10));

  const wdLine = text.match(
    /(?:week(?:ly)?(?:_all(?:_models)?)?|7.?d(?:ay)?)[^\n]*/i
  )?.[0] ?? "";
  const wdReset = wdLine.match(/resets?\s+(?:in\s+)?([^\n,|]+)/i)?.[1]?.trim();
  if (wdReset) result.week7dReset = wdReset;

  // ── Sonnet / Opus per-model weekly (bonus if present) ───────────────────
  const son = text.match(/(?:sonnet)[^\n]*?(\d{1,3})\s*%/i);
  if (son) result.weekSonnetPct = Math.min(100, parseInt(son[1], 10));
  const opus = text.match(/(?:opus)[^\n]*?(\d{1,3})\s*%/i);
  if (opus) result.weekOpusPct = Math.min(100, parseInt(opus[1], 10));

  return Object.keys(result).length > 0 ? result : null;
}

/** Locate the claude binary — check PATH, then a few known install locations. */
function findClaudeBin() {
  // Check well-known install paths first (Windows & Unix).
  const candidates = [
    "claude", // on PATH
    join(homedir(), ".claude", "local", "claude"),
    join(homedir(), ".nvm", "versions", "node", "current", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const c of candidates) {
    // For "claude" (no path separator), rely on execFile PATH resolution.
    if (!c.includes("/") && !c.includes("\\")) return c;
    if (existsSync(c)) return c;
  }
  return "claude"; // fall through — let execFile fail gracefully
}

/**
 * Attempt to read Claude rate-limit quota via the CLI.
 * Returns a quota object or {ok:false} on failure.
 */
export async function fetchClaudeQuota({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;

  const bin = findClaudeBin();
  let parsed = null;

  // Strategy 1: non-interactive --print mode (Claude Code ≥ 1.x)
  try {
    const { stdout, stderr } = await execFileAsync(
      bin,
      ["--print", "/usage"],
      {
        timeout: 10_000,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb", CI: "1" },
      }
    );
    parsed = parseUsageText(stdout + "\n" + stderr);
  } catch { /* not in PATH, timed out, or /usage not recognised */ }

  // Strategy 2: pipe mode — some older versions respond to piped stdin
  if (!parsed) {
    try {
      const { stdout, stderr } = await execFileAsync(
        bin,
        ["--dangerously-skip-permissions"],
        {
          timeout: 8_000,
          input: "/usage\n",
          env: { ...process.env, NO_COLOR: "1", TERM: "dumb", CI: "1" },
        }
      );
      parsed = parseUsageText(stdout + "\n" + stderr);
    } catch { /* ignore */ }
  }

  const result = parsed
    ? { ok: true, ...parsed, fetchedAt: now }
    : { ok: false, fetchedAt: now };

  _cache = result;
  _cacheAt = now;
  return result;
}

/** Invalidate the cache so the next /api/quota call re-fetches. */
export function invalidateQuotaCache() {
  _cache = null;
  _cacheAt = 0;
}
