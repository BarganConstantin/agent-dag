import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  ReactFlowProvider,
} from "reactflow";
import AgentNode from "./components/AgentNode";
import { autoLayout } from "./layout";
import { applyEvent, initialState, sessionHue, type GraphState } from "./reducer";
import type { AgentNodeData, HookEnvelope, ToolCall } from "./types";

function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "";
}

const nodeTypes = { agent: AgentNode };

function snapshotToFlow(
  state: GraphState,
  now: number,
  pinned: Map<string, { x: number; y: number }>,
): { nodes: Node<AgentNodeData & { now: number }>[]; edges: Edge[] } {
  const nodes: Node<AgentNodeData & { now: number }>[] = [];
  const edges: Edge[] = [];
  for (const a of state.agents.values()) {
    nodes.push({
      id: a.id,
      type: "agent",
      position: { x: 0, y: 0 },
      data: { ...a, now },
    });
    if (a.parentId && state.agents.has(a.parentId)) {
      const hue = sessionHue(a.sessionId);
      const stroke = a.state === "active" ? `hsl(${hue} 80% 72%)` : `hsl(${hue} 50% 55%)`;
      edges.push({
        id: `e:${a.parentId}->${a.id}`,
        source: a.parentId,
        target: a.id,
        animated: a.state === "active",
        type: "smoothstep",
        label: a.label,
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 4,
        labelStyle: { fontSize: 10, fill: stroke, fontFamily: "ui-monospace, monospace" },
        labelBgStyle: { fill: "var(--bg-soft)", fillOpacity: 0.85, stroke, strokeWidth: 0.5 },
        style: { stroke, strokeWidth: a.state === "active" ? 2 : 1.5 },
      });
    }
  }
  return { nodes: autoLayout(nodes, edges, { direction: "LR", pinned }), edges };
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}

function Inner() {
  const stateRef = useRef<GraphState>(initialState());
  const [, force] = useState(0);
  const rerender = useCallback(() => force(x => x + 1), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const queueRef = useRef<HookEnvelope[]>([]);
  const [now, setNow] = useState(Date.now());
  const pinnedRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return (window.localStorage.getItem("ccgraph.theme") as "dark" | "light") ?? "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem("ccgraph.theme", theme); } catch {}
  }, [theme]);

  // SSE subscription
  useEffect(() => {
    const es = new EventSource("/events");
    es.addEventListener("open", () => setLive(true));
    es.addEventListener("error", () => setLive(false));
    es.addEventListener("hook", (e) => {
      try {
        const env: HookEnvelope = JSON.parse((e as MessageEvent).data);
        if (paused) { queueRef.current.push(env); return; }
        stateRef.current = applyEvent(stateRef.current, env);
        rerender();
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, [paused, rerender]);

  // Drain queue when un-paused
  useEffect(() => {
    if (paused) return;
    if (queueRef.current.length === 0) return;
    for (const env of queueRef.current) stateRef.current = applyEvent(stateRef.current, env);
    queueRef.current.length = 0;
    rerender();
  }, [paused, rerender]);

  // Tick clock so elapsed-time fields refresh smoothly.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { nodes, edges } = useMemo(
    () => snapshotToFlow(stateRef.current, now, pinnedRef.current),
    [stateRef.current, stateRef.current.lastSeq, now],
  );

  const selected = selectedId ? stateRef.current.agents.get(selectedId) : null;

  const handleClear = useCallback(async () => {
    try { await fetch("/api/clear", { method: "POST" }); } catch {}
    stateRef.current = initialState();
    pinnedRef.current.clear();
    setSelectedId(null);
    rerender();
  }, [rerender]);

  const handleRelayout = useCallback(() => {
    pinnedRef.current.clear();
    rerender();
  }, [rerender]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === " ") { e.preventDefault(); setPaused(p => !p); }
      if (e.key === "c" || e.key === "C") handleClear();
      if (e.key === "r" || e.key === "R") handleRelayout();
      if (e.key === "t" || e.key === "T") setTheme(t => (t === "dark" ? "light" : "dark"));
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClear, handleRelayout]);

  const agentCount = stateRef.current.agents.size;
  const sessionCount = new Set(Array.from(stateRef.current.agents.values()).map(a => a.sessionId)).size;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          ccgraph <span className="v">v0.2</span>
        </div>
        <div className="actions">
          <span className="status">
            <span className={`pill ${live ? "live" : "dead"}`}>{live ? "live" : "disconnected"}</span>
            <span><span className="count">{sessionCount}</span> sessions</span>
            <span><span className="count">{agentCount}</span> agents</span>
            <span><span className="count">{stateRef.current.totalEvents}</span> events</span>
          </span>
          <button className="btn" onClick={() => setPaused(p => !p)} title="Space">
            {paused ? `Resume${queueRef.current.length ? ` (${queueRef.current.length})` : ""}` : "Pause"}
          </button>
          <button className="btn" onClick={handleRelayout} title="R — auto-arrange">Re-layout</button>
          <button className="btn" onClick={handleClear} title="C">Clear</button>
          <button
            className="btn icon-btn"
            onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}
            title="Toggle theme (T)"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <div className="canvas-wrap">
        {agentCount === 0 && <EmptyHero />}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.25, duration: 400 }}
          minZoom={0.2}
          maxZoom={1.6}
          panOnScroll
          nodesDraggable
          nodesConnectable={false}
          selectionOnDrag={false}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
          onNodeDragStop={(_, n) => {
            pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
          }}
        >
          <Background gap={28} size={1} color={cssVar("--grid-line")} />
          <Controls showInteractive={false} />
          <MiniMap
            zoomable
            pannable
            nodeColor={n => {
              const d = n.data as AgentNodeData;
              if (d.state === "err") return cssVar("--err");
              if (d.state === "active") return cssVar("--inflight");
              return cssVar("--ok");
            }}
            nodeStrokeWidth={2}
            maskColor={cssVar("--minimap-mask")}
            style={{ background: cssVar("--panel"), border: `1px solid ${cssVar("--line")}`, borderRadius: 8 }}
          />
        </ReactFlow>
      </div>

      <aside className="detail">
        {selected ? <Detail agent={selected} now={now} /> : <EmptyDetail count={agentCount} />}
      </aside>
    </div>
  );
}

function EmptyHero() {
  return (
    <div className="empty-hero">
      <div className="orbit-stack" aria-hidden>
        <div className="core" />
        <div className="orbit r1"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r2"><span className="dot" /><span className="dot b" /></div>
        <div className="orbit r3"><span className="dot" /><span className="dot b" /></div>
      </div>
      <h2>Waiting for Claude Code</h2>
      <p>
        Run <code>claude</code> in any folder. As soon as a session sends an event,
        a node appears here and grows as subagents fork and tools are called.
      </p>
    </div>
  );
}

function EmptyDetail({ count }: { count: number }) {
  return (
    <>
      <h3>Detail</h3>
      {count === 0 ? (
        <div className="hint">
          No data yet. Start a Claude Code session anywhere on this machine —
          ccgraph is in <code>--all</code> mode and listens to every workspace.
        </div>
      ) : (
        <div className="empty">Click an agent to see its tools.</div>
      )}
      <h3 style={{ marginTop: 4 }}>Shortcuts</h3>
      <div className="row"><span className="k">drag</span><span className="v">move a node</span></div>
      <div className="row"><span className="k">space</span><span className="v">pause / resume</span></div>
      <div className="row"><span className="k">r</span><span className="v">re-arrange (clear pins)</span></div>
      <div className="row"><span className="k">c</span><span className="v">clear canvas</span></div>
      <div className="row"><span className="k">t</span><span className="v">toggle theme</span></div>
      <div className="row"><span className="k">esc</span><span className="v">deselect node</span></div>
    </>
  );
}

function Detail({ agent, now }: { agent: AgentNodeData; now: number }) {
  const elapsedSec = Math.max(0, Math.floor(((agent.endedAt ?? now) - agent.startedAt) / 1000));
  return (
    <>
      <h3>{agent.label}</h3>
      <div>
        <div className="row"><span className="k">kind</span><span className="v">{agent.kind}</span></div>
        <div className="row"><span className="k">state</span><span className="v">{agent.state}</span></div>
        <div className="row"><span className="k">elapsed</span><span className="v">{elapsedSec}s</span></div>
        <div className="row"><span className="k">tools</span><span className="v">{agent.toolCount}</span></div>
        {agent.cwd && <div className="row"><span className="k">cwd</span><span className="v" title={agent.cwd}>{agent.cwd}</span></div>}
        <div className="row"><span className="k">session</span><span className="v">{agent.sessionId.slice(0, 8)}…</span></div>
      </div>

      {agent.firstPrompt && (
        <>
          <h3>First prompt</h3>
          <div className="hint" style={{ borderStyle: "solid" }}>{agent.firstPrompt}</div>
        </>
      )}

      <h3>Tool calls ({agent.tools.length})</h3>
      {agent.tools.length === 0 && <div className="empty">No tool calls yet.</div>}
      <div>
        {agent.tools.slice().reverse().map(t => (
          <ToolRow key={t.id} t={t} now={now} />
        ))}
      </div>
    </>
  );
}

function ToolRow({ t, now }: { t: ToolCall; now: number }) {
  const status = t.endedAt == null ? "inflight" : t.ok === false ? "err" : "done";
  const dur = (t.endedAt ?? now) - t.startedAt;
  const durLabel = t.endedAt == null ? "…" : dur < 1000 ? `${dur}ms` : `${(dur / 1000).toFixed(1)}s`;
  return (
    <div className="tool" title={t.inputPreview || t.name}>
      <span className="name">
        <span className={`status-dot ${status}`} />
        {t.name}
      </span>
      <span style={{ color: "var(--muted)" }}>{durLabel}</span>
    </div>
  );
}
