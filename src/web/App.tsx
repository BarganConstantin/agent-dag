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
import { applyEvent, initialState, type GraphState } from "./reducer";
import type { AgentNodeData, HookEnvelope } from "./types";

const nodeTypes = { agent: AgentNode };

function snapshotToFlow(state: GraphState): { nodes: Node<AgentNodeData>[]; edges: Edge[] } {
  const nodes: Node<AgentNodeData>[] = [];
  const edges: Edge[] = [];
  for (const a of state.agents.values()) {
    nodes.push({
      id: a.id,
      type: "agent",
      position: { x: 0, y: 0 }, // dagre sets real position
      data: a,
    });
    if (a.parentId && state.agents.has(a.parentId)) {
      edges.push({
        id: `e:${a.parentId}->${a.id}`,
        source: a.parentId,
        target: a.id,
        animated: a.state === "active",
        type: "smoothstep",
      });
    }
  }
  return { nodes: autoLayout(nodes, edges, "LR"), edges };
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

  const { nodes, edges } = useMemo(() => snapshotToFlow(stateRef.current), [stateRef.current, stateRef.current.lastSeq]);

  const selected = selectedId ? stateRef.current.agents.get(selectedId) : null;

  const handleClear = useCallback(async () => {
    try { await fetch("/api/clear", { method: "POST" }); } catch {}
    stateRef.current = initialState();
    setSelectedId(null);
    rerender();
  }, [rerender]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" /> ccgraph
        </div>
        <div className="actions">
          <span className="status">
            {live ? <span className="live">live</span> : <span>disconnected</span>}
            {" · "}
            <span>{stateRef.current.totalEvents} events</span>
            {" · "}
            <span>{stateRef.current.agents.size} agents</span>
          </span>
          <button className="btn" onClick={() => setPaused(p => !p)}>{paused ? "Resume" : "Pause"}</button>
          <button className="btn" onClick={handleClear}>Clear</button>
        </div>
      </header>

      <div className="canvas-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          maxZoom={1.6}
          panOnScroll
          selectionOnDrag={false}
          onNodeClick={(_, n) => setSelectedId(n.id)}
          onPaneClick={() => setSelectedId(null)}
        >
          <Background gap={24} size={1} color="#1e2128" />
          <Controls showInteractive={false} />
          <MiniMap
            zoomable
            pannable
            nodeColor={n => {
              const d = n.data as AgentNodeData;
              if (d.state === "err") return "#fca5a5";
              if (d.state === "active") return "#f0abfc";
              return "#86efac";
            }}
            maskColor="rgba(12,13,16,0.85)"
            style={{ background: "#14161b", border: "1px solid #1f2229" }}
          />
        </ReactFlow>
      </div>

      <aside className="detail">
        {selected ? <Detail agent={selected} /> : <EmptyDetail count={stateRef.current.agents.size} />}
      </aside>
    </div>
  );
}

function EmptyDetail({ count }: { count: number }) {
  return (
    <>
      <h3>Detail</h3>
      <div className="empty">
        {count === 0
          ? "Waiting for Claude Code events. Run a session in any directory."
          : "Click an agent to see its tools."}
      </div>
    </>
  );
}

function Detail({ agent }: { agent: AgentNodeData }) {
  return (
    <>
      <h3>{agent.label}</h3>
      <div className="row"><span className="k">id</span><span className="v">{agent.id.slice(0, 12)}…</span></div>
      <div className="row"><span className="k">kind</span><span className="v">{agent.kind}</span></div>
      <div className="row"><span className="k">state</span><span className="v">{agent.state}</span></div>
      <div className="row"><span className="k">tools</span><span className="v">{agent.toolCount}</span></div>
      {agent.cwd && <div className="row"><span className="k">cwd</span><span className="v" style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{agent.cwd}</span></div>}
      <h3 style={{ marginTop: 16 }}>Tool calls</h3>
      {agent.tools.length === 0 && <div className="empty">No tool calls yet.</div>}
      {agent.tools.slice().reverse().map(t => {
        const status = t.endedAt == null ? "inflight" : t.ok === false ? "err" : "done";
        return (
          <div className="tool" key={t.id} title={t.inputPreview}>
            <span><span className={`status-dot ${status}`} />{t.name}</span>
            <span style={{ color: "var(--muted)" }}>
              {t.endedAt ? `${t.endedAt - t.startedAt}ms` : "…"}
            </span>
          </div>
        );
      })}
    </>
  );
}
