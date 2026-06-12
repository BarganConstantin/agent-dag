// ccgraph server: HTTP ingest + SSE broadcast + static file serving.
// Single-file pure Node HTTP server, zero deps.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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

function pushEvent(raw, source) {
  const seq = nextSeq++;
  const evt = {
    seq,
    receivedAt: Date.now(),
    source,
    payload: raw,
  };
  events.push(evt);
  if (events.length > MAX_BUFFER) events.splice(0, events.length - MAX_BUFFER);

  const line = `id: ${seq}\nevent: hook\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }
  return evt;
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
    name: "ccgraph",
    seq: nextSeq - 1,
    clients: sseClients.size,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

export function startServer({ port = 4317, host = "127.0.0.1" } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

    if (req.method === "POST" && url.pathname === "/api/event") return handleEventIngest(req, res);
    if (req.method === "GET"  && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET"  && url.pathname === "/events")     return handleSse(req, res);

    if (req.method === "GET" && url.pathname === "/api/events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return send(res, 200, events.filter(e => e.seq > since));
    }

    // POST /api/clear — wipe in-memory buffer (UI reset button)
    if (req.method === "POST" && url.pathname === "/api/clear") {
      events.length = 0;
      pushEvent({ hook_event_name: "__clear", cwd: "" }, "internal");
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET") return serveStatic(req, res, url);
    send(res, 405, { error: "method not allowed" });
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, host, () => {
      server.removeListener("error", rejectStart);
      resolveStart(server);
    });
  });
}

// Allow running this file directly for dev.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const port = Number(process.env.CCGRAPH_PORT ?? 4317);
  startServer({ port }).then(s => {
    const addr = s.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`ccgraph server: http://127.0.0.1:${p}`);
  }).catch(e => {
    console.error("ccgraph server failed:", e.message);
    process.exit(1);
  });
}
