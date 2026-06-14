// Floating activity strip at the bottom of the canvas. Two modes:
//
//   "tools" — every tool call from the last WINDOW_MS as a category-
//             colored dot positioned on a time axis. Click → select +
//             open modal. (Default when there's no cost yet.)
//
//   "$"     — smooth area chart of cumulative spend over the same
//             window. Surfaces where the money's actually going.
//             Driven by the costSamples buffer maintained in App.tsx.
//
// Mode toggle lives in the header. Last-used mode is remembered in
// localStorage so a reload keeps the user's choice.
import React, { useEffect, useMemo, useState } from "react";
import { fmtCost } from "../pricing";
import type { AgentNodeData } from "../types";

const WINDOW_MS = 120_000; // 2 minutes
const MAX_DOTS = 400;
const MODE_STORAGE_KEY = "agent-dag.timelineMode";

type Mode = "tools" | "cost";
function loadMode(): Mode {
  if (typeof window === "undefined") return "tools";
  try {
    const v = window.localStorage.getItem(MODE_STORAGE_KEY);
    return v === "cost" ? "cost" : "tools";
  } catch { return "tools"; }
}
function saveMode(m: Mode): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(MODE_STORAGE_KEY, m); } catch {}
}

type Category = "file" | "shell" | "web" | "agent" | "task" | "plan" | "mcp" | "other";
const CAT: Record<string, Category> = {
  Read: "file", Write: "file", Edit: "file", MultiEdit: "file",
  Glob: "file", Grep: "file", LS: "file", NotebookEdit: "file",
  Bash: "shell", PowerShell: "shell",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
  TodoWrite: "task", TaskCreate: "task", TaskUpdate: "task",
  TaskList: "task", TaskGet: "task", TaskOutput: "task", TaskStop: "task",
  EnterPlanMode: "plan", ExitPlanMode: "plan", AskUserQuestion: "plan",
  Skill: "plan", Workflow: "plan",
};
function categoryFor(name: string): Category {
  if (name.startsWith("mcp__")) return "mcp";
  return CAT[name] ?? "other";
}

interface Dot {
  agentId: string;
  toolId: string;
  name: string;
  category: Category;
  startedAt: number;
  endedAt?: number;
  inflight: boolean;
  errored: boolean;
}

function collectDots(agents: Map<string, AgentNodeData>, earliest: number): Dot[] {
  const out: Dot[] = [];
  for (const a of agents.values()) {
    for (const t of a.tools) {
      if (t.startedAt < earliest) continue;
      out.push({
        agentId: a.id,
        toolId: t.id,
        name: t.name,
        category: categoryFor(t.name),
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        inflight: t.endedAt == null,
        errored: t.ok === false,
      });
    }
  }
  out.sort((x, y) => x.startedAt - y.startedAt);
  return out.length > MAX_DOTS ? out.slice(out.length - MAX_DOTS) : out;
}

interface Props {
  agents: Map<string, AgentNodeData>;
  now: number;
  /** Per-second cumulative cost snapshots, oldest first. */
  costSamples: Array<{ t: number; cost: number }>;
  onSelect: (agentId: string) => void;
  onOpenTool: (toolId: string) => void;
  onClose: () => void;
}

export default function TimelineStrip({ agents, now, costSamples, onSelect, onOpenTool, onClose }: Props) {
  const [mode, setMode] = useState<Mode>(loadMode);
  useEffect(() => { saveMode(mode); }, [mode]);

  const earliest = now - WINDOW_MS;
  const dots = useMemo(() => collectDots(agents, earliest), [agents, earliest]);
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const d of dots) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, [dots]);

  // Cost-chart series: filter samples in the window + clip duration.
  const series = useMemo(() => costSamples.filter(s => s.t >= earliest), [costSamples, earliest]);
  const costMax = useMemo(() => series.reduce((m, s) => Math.max(m, s.cost), 0), [series]);
  const costNow = series.length > 0 ? series[series.length - 1].cost : 0;
  const costStart = series.length > 0 ? series[0].cost : 0;
  const costDelta = costNow - costStart;

  return (
    <div className="timeline-strip" role="region" aria-label={mode === "cost" ? "Spend over time" : "Recent tool activity"}>
      <div className="ts-header">
        <div className="ts-mode-toggle" role="tablist" aria-label="Timeline mode">
          <button
            role="tab"
            className={`ts-mode${mode === "tools" ? " on" : ""}`}
            onClick={() => setMode("tools")}
            aria-selected={mode === "tools"}
            title="Show recent tool calls"
          >tools</button>
          <button
            role="tab"
            className={`ts-mode${mode === "cost" ? " on" : ""}`}
            onClick={() => setMode("cost")}
            aria-selected={mode === "cost"}
            title="Show cumulative spend"
          >$</button>
        </div>
        <span className="ts-title">Last 2 min</span>
        {mode === "tools" ? (
          <>
            <span className="ts-total">{dots.length} tool call{dots.length === 1 ? "" : "s"}</span>
            <div className="ts-legend">
              {Array.from(counts.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([c, n]) => (
                  <span key={c} className={`ts-legend-item cat-${c}`} title={`${n} ${c}`}>
                    <span className="ts-legend-dot" />
                    {n}
                  </span>
                ))}
            </div>
          </>
        ) : (
          <>
            <span className="ts-total">
              {fmtCost(costNow)}
              {costDelta > 0 && <span className="ts-delta"> · +{fmtCost(costDelta)}</span>}
            </span>
            <div className="ts-legend" />
          </>
        )}
        <button className="btn icon-btn ts-close" onClick={onClose} title="Hide timeline" aria-label="Hide timeline">×</button>
      </div>
      <div className="ts-track" aria-hidden>
        {[2, 1.5, 1, 0.5, 0].map(min => (
          <span key={min} className="ts-tick" style={{ left: `${((2 - min) / 2) * 100}%` }}>
            {min === 0 ? "now" : `${min}m`}
          </span>
        ))}
        <span className="ts-now-line" />
        {mode === "tools"
          ? dots.map(d => {
              const x = ((d.startedAt - earliest) / WINDOW_MS) * 100;
              const status = d.inflight ? "inflight" : d.errored ? "err" : "done";
              return (
                <button
                  key={d.toolId}
                  className={`ts-dot cat-${d.category} status-${status}`}
                  style={{ left: `${x}%` }}
                  onClick={() => { onSelect(d.agentId); onOpenTool(d.toolId); }}
                  title={`${d.name} · ${new Date(d.startedAt).toLocaleTimeString()}${d.endedAt ? ` (${Math.max(0, d.endedAt - d.startedAt)}ms)` : " — running"}`}
                  aria-label={`${d.name} ${status}`}
                />
              );
            })
          : <CostChart series={series} earliest={earliest} windowMs={WINDOW_MS} costMax={costMax} />}
      </div>
    </div>
  );
}

/** Smooth area chart of cumulative cost samples. Renders inside the
 *  parent's ts-track box (positioned absolutely, fills 100% × 100%).
 *  Empty when there are <2 samples — needs a baseline to draw. */
function CostChart({
  series, earliest, windowMs, costMax,
}: {
  series: Array<{ t: number; cost: number }>;
  earliest: number;
  windowMs: number;
  costMax: number;
}) {
  if (series.length < 2 || costMax <= 0) {
    return <div className="ts-chart-empty">collecting samples…</div>;
  }
  // ViewBox: 0..100 wide, 0..100 tall. Time → x (left to right),
  // cost → y (inverted so high cost is at the top of the chart).
  const xOf = (t: number) => Math.max(0, Math.min(100, ((t - earliest) / windowMs) * 100));
  // Top-pad so the line never kisses the ceiling.
  const yOf = (c: number) => 100 - (c / costMax) * 92 - 4;

  // Build a smooth Catmull-Rom-ish path by averaging neighbouring midpoints.
  // The series is monotonically non-decreasing (cost only goes up), so
  // simple cubic interpolation looks natural without overshoot.
  const pts = series.map(s => ({ x: xOf(s.t), y: yOf(s.cost) }));
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    const cx = (p0.x + p1.x) / 2;
    d += ` C ${cx.toFixed(2)} ${p0.y.toFixed(2)}, ${cx.toFixed(2)} ${p1.y.toFixed(2)}, ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  // Close the area down to the baseline so the fill works.
  const fillD = `${d} L ${last.x.toFixed(2)} 100 L ${pts[0].x.toFixed(2)} 100 Z`;

  return (
    <svg className="ts-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="ts-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(150 60% 60%)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="hsl(150 60% 60%)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={fillD} fill="url(#ts-fill)" />
      <path d={d} fill="none" stroke="hsl(150 70% 65%)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
      {/* current-value dot at the right edge */}
      <circle cx={last.x} cy={last.y} r="1.4" fill="hsl(150 80% 70%)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
