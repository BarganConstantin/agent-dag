#!/usr/bin/env node
// ccgraph hook forwarder. Claude Code invokes this as a command hook.
// It reads stdin (CC event JSON), finds the matching ccgraph server via
// per-workspace discovery files in ~/.claude/ccgraph/, and forwards the
// payload to it via HTTP POST. Dead instances are cleaned up.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

// Hard cap so a stuck server can never wedge Claude Code.
setTimeout(() => process.exit(0), 1500);

const DIR = path.join(os.homedir(), ".claude", "ccgraph");
const IS_WIN = process.platform === "win32";

function normPath(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync(r); } catch {}
  return r;
}

function isAlive(pid) {
  if (IS_WIN) return true; // signal 0 unreliable on win
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { input += c; });
process.stdin.on("end", () => {
  let cwd;
  try { cwd = JSON.parse(input).cwd; } catch { return process.exit(0); }
  if (!cwd) return process.exit(0);

  const resolvedCwd = normPath(cwd);

  let files;
  try {
    files = fs.readdirSync(DIR).filter(f => f.endsWith(".json"));
  } catch { return process.exit(0); }
  if (!files.length) return process.exit(0);

  const matches = [];
  for (const file of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")); } catch { continue; }
    if (typeof d.workspace !== "string" || !d.pid || !d.port) continue;

    if (!isAlive(d.pid)) {
      try { fs.unlinkSync(path.join(DIR, file)); } catch {}
      continue;
    }

    // Empty workspace = match-all (used by `ccgraph --all`).
    if (d.workspace === "") {
      matches.push({ d, wsLen: 0 });
      continue;
    }
    const ws = normPath(d.workspace);
    if (resolvedCwd === ws || resolvedCwd.startsWith(ws + path.sep)) {
      matches.push({ d, wsLen: ws.length });
    }
  }

  if (!matches.length) return process.exit(0);

  // Most specific workspace wins.
  matches.sort((a, b) => b.wsLen - a.wsLen);
  const bestLen = matches[0].wsLen;
  const targets = matches.filter(m => m.wsLen === bestLen);

  let pending = targets.length;
  const done = () => { if (--pending <= 0) process.exit(0); };

  for (const { d } of targets) {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; done(); };
    const req = http.request({
      hostname: "127.0.0.1",
      port: d.port,
      path: "/api/event",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 1000,
    }, res => { res.resume(); res.on("end", finish); });
    req.on("error", finish);
    req.on("timeout", () => req.destroy());
    req.write(input);
    req.end();
  }
});
