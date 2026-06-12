// agent-dag server: HTTP ingest + SSE broadcast + static file serving.
// Single-file pure Node HTTP server, zero deps.
import { createServer } from "node:http";
import { readFile, stat, mkdir, appendFile, open, truncate, readdir, unlink } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, dirname as pdirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");
const WEB_DIST = resolve(PKG_ROOT, "dist", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".woff2": "font/woff2",
  ".map":  "application/json",
};

const MAX_BUFFER = 2000;            // recent events kept for late SSE subscribers
const events = [];                  // ring buffer
let nextSeq = 1;
const sseClients = new Set();       // res handles

let persistPath = null;             // absolute path to events.jsonl, or null

function pushEvent(raw, source, opts = {}) {
  const seq = nextSeq++;
  const evt = {
    seq,
    receivedAt: opts.receivedAt ?? Date.now(),
    source,
    payload: raw,
  };
  events.push(evt);
  if (events.length > MAX_BUFFER) events.splice(0, events.length - MAX_BUFFER);

  const line = `id: ${seq}\nevent: hook\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }

  if (persistPath && !opts.replay) {
    // Fire-and-forget append. JSONL = newline-delimited JSON.
    appendFile(persistPath, JSON.stringify(evt) + "\n", "utf8").catch(() => {});
  }

  return evt;
}

async function replayLog(filePath) {
  if (!existsSync(filePath)) return 0;
  let count = 0;
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }) });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line);
      if (evt && typeof evt === "object" && evt.payload) {
        pushEvent(evt.payload, evt.source ?? "replay", { receivedAt: evt.receivedAt, replay: true });
        count++;
      }
    } catch { /* skip corrupt line */ }
  }
  return count;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function serveStatic(req, res, url) {
  // Strip leading slash, default to index.html
  let rel = url.pathname.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  const filePath = join(WEB_DIST, rel);
  if (!filePath.startsWith(WEB_DIST)) return send(res, 403, { error: "forbidden" });

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) return send(res, 404, { error: "not found" });
    const buf = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch {
    // SPA fallback to index.html for client-side routes
    try {
      const idx = await readFile(join(WEB_DIST, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(idx);
    } catch {
      send(res, 404, { error: "ui not built. run `pnpm build` or `npm run build`." });
    }
  }
}

function handleEventIngest(req, res) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", c => {
    body += c;
    if (body.length > 5_000_000) {
      req.destroy();
    }
  });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid json" }); }
    const evt = pushEvent(parsed, "hook");
    send(res, 200, { ok: true, seq: evt.seq });
  });
  req.on("error", () => send(res, 400, { error: "bad request" }));
}

function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 1500\n\n`);

  // Resume: replay events after Last-Event-ID
  const lastId = Number(req.headers["last-event-id"] ?? 0);
  for (const e of events) {
    if (e.seq <= lastId) continue;
    res.write(`id: ${e.seq}\nevent: hook\ndata: ${JSON.stringify(e)}\n\n`);
  }

  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

function handleHealth(_req, res) {
  send(res, 200, {
    ok: true,
    name: "agent-dag",
    seq: nextSeq - 1,
    clients: sseClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

async function sweepStaleDiscovery() {
  const dir = join(homedir(), ".claude", "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const d = JSON.parse(await readFile(p, "utf8"));
      if (d && typeof d.pid === "number" && !isProcessAlive(d.pid)) {
        await unlink(p).catch(() => {});
        removed++;
      }
    } catch { /* corrupt — leave it */ }
  }
  return removed;
}

function randomPort(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function tryListen(server, port, host) {
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => {
      server.removeListener("error", rej);
      res();
    });
  });
}

export async function startServer({ port = 4317, host = "127.0.0.1", persist = null, portRange = [4318, 4400] } = {}) {
  const removed = await sweepStaleDiscovery();
  if (removed > 0) console.log(`  swept ${removed} stale discovery file(s)`);
  if (persist) {
    persistPath = resolve(persist);
    try { await mkdir(pdirname(persistPath), { recursive: true }); } catch {}
    const replayed = await replayLog(persistPath);
    if (replayed > 0) {
      // Don't broadcast replays as live; SSE clients catch up via Last-Event-ID
      // already. Just keep the buffer + seq counter primed.
    }
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

    if (req.method === "POST" && url.pathname === "/api/event") return handleEventIngest(req, res);
    if (req.method === "GET"  && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET"  && url.pathname === "/events")     return handleSse(req, res);

    if (req.method === "GET" && url.pathname === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return send(res, 200, events.filter(e => e.seq > since));
    }

    // POST /api/clear — wipe in-memory buffer + persistence file (UI reset)
    if (req.method === "POST" && url.pathname === "/api/clear") {
      events.length = 0;
      if (persistPath) truncate(persistPath, 0).catch(() => {});
      pushEvent({ hook_event_name: "__clear", cwd: "" }, "internal");
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET") return serveStatic(req, res, url);
    send(res, 405, { error: "method not allowed" });
  });

  // Try requested port first, then up to 10 random ports from portRange.
  const candidates = [port];
  for (let i = 0; i < 10; i++) candidates.push(randomPort(portRange[0], portRange[1]));

  for (const candidate of candidates) {
    try {
      await tryListen(server, candidate, host);
      return server;
    } catch (err) {
      if (err && err.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw Object.assign(new Error(`all ports tried — none available`), { code: "EADDRINUSE" });
}

// Allow running this file directly for dev.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CCGRAPH_PORT ?? 4317);
  startServer({ port }).then(s => {
    const addr = s.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`agent-dag server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error("agent-dag server failed:", e.message);
    process.exit(1);
  });
}
