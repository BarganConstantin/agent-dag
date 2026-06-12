// Idempotent hook installer for ~/.claude/settings.json.
// Adds a single command-hook entry per CC hook event pointing at our forwarder.
// Re-runs are safe (entries are tagged with __agent-dag and de-duped).
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const AGENT_DAG_DIR = join(CLAUDE_DIR, "agent-dag");

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
  "Notification",
];

const MARK_KEY = "__agent-dag";
// Legacy marks from earlier names — purged on every install/uninstall so
// duplicate forwarders don't pile up when the project gets renamed.
const LEGACY_MARKS = ["__ccgraph", "__agent-flow"];
// ~/.claude/<name>/hook.js paths used by old releases. Any unmarked entry
// pointing into one of these is recognised as ours and removed.
const LEGACY_DIRS = ["ccgraph", "agent-flow", "agent-dag"];

function hookCommand(installedHookPath) {
  // process.execPath = absolute path to current node (works on Win + *nix).
  const node = process.execPath;
  return `"${node}" "${installedHookPath}"`;
}

function isOurEntry(g) {
  if (!g || typeof g !== "object") return false;
  if (g[MARK_KEY] === true) return true;
  for (const k of LEGACY_MARKS) if (g[k] === true) return true;
  // Heuristic: command points at ~/.claude/<legacy-dir>/hook.js.
  const cmds = Array.isArray(g.hooks) ? g.hooks : [];
  for (const h of cmds) {
    const c = typeof h?.command === "string" ? h.command : "";
    for (const dir of LEGACY_DIRS) {
      if (c.includes(`.claude/${dir}/hook.js`) || c.includes(`.claude\\${dir}\\hook.js`)) return true;
    }
  }
  return false;
}

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function readJsonSafe(p) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}

async function installHookScript() {
  await ensureDir(AGENT_DAG_DIR);
  const src = join(PKG_ROOT, "hook", "hook.js");
  const dst = join(AGENT_DAG_DIR, "hook.js");
  await copyFile(src, dst);
  return dst;
}

function buildHookEntry(command) {
  return {
    [MARK_KEY]: true,
    hooks: [{ type: "command", command, timeout: 2 }],
  };
}

function dedupeOurEntries(group) {
  if (!Array.isArray(group)) return [];
  return group.filter(g => !isOurEntry(g));
}

export async function installHooks() {
  const hookPath = await installHookScript();
  const command = hookCommand(hookPath);
  await ensureDir(CLAUDE_DIR);

  const current = (await readJsonSafe(SETTINGS)) ?? {};
  current.hooks = current.hooks ?? {};

  for (const evt of HOOK_EVENTS) {
    const cleaned = dedupeOurEntries(current.hooks[evt]);
    cleaned.push(buildHookEntry(command));
    current.hooks[evt] = cleaned;
  }

  await writeFile(SETTINGS, JSON.stringify(current, null, 2) + "\n", "utf8");
  return { settingsPath: SETTINGS, hookPath, events: HOOK_EVENTS };
}

export async function uninstallHooks() {
  const current = await readJsonSafe(SETTINGS);
  if (!current?.hooks) return { changed: false };
  let changed = false;
  for (const evt of Object.keys(current.hooks)) {
    const cleaned = dedupeOurEntries(current.hooks[evt]);
    if (cleaned.length !== (current.hooks[evt]?.length ?? 0)) changed = true;
    if (cleaned.length === 0) delete current.hooks[evt];
    else current.hooks[evt] = cleaned;
  }
  if (changed) await writeFile(SETTINGS, JSON.stringify(current, null, 2) + "\n", "utf8");
  return { changed };
}

export async function writeDiscovery({ port, workspace }) {
  await ensureDir(AGENT_DAG_DIR);
  const file = join(AGENT_DAG_DIR, `${process.pid}.json`);
  const data = {
    pid: process.pid,
    port,
    workspace: workspace ?? "",
    startedAt: new Date().toISOString(),
  };
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}

export async function removeDiscovery(file) {
  try { await unlink(file); } catch {}
}

export { AGENT_DAG_DIR, SETTINGS };
