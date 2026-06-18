// UsagePanel — floating panel showing aggregated token usage and cost
// across all sessions, by model and by session. Toggled via $ button
// in the topbar or the U keyboard shortcut.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { costForUsage, fmtCost, fmtCostRate, type CostBreakdown } from "../pricing";
import type { GraphState } from "../reducer";
import type { AgentState } from "../types";
import { shortModel } from "./AgentNode";

// ── Quota types ────────────────────────────────────────────────────────────
interface QuotaData {
  ok: boolean;
  session5hPct?: number;
  session5hReset?: string;
  week7dPct?: number;
  week7dReset?: string;
  weekSonnetPct?: number;
  weekOpusPct?: number;
  fetchedAt?: number;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

interface ModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: CostBreakdown;
  agentCount: number;
}

interface SessionRow {
  sessionId: string;
  label: string;
  state: AgentState;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

function CostBar({ cost }: { cost: CostBreakdown }) {
  const total = cost.total;
  if (total <= 0) return null;
  const seg = (val: number, cls: string, label: string) => {
    if (val <= 0) return null;
    const pct = (val / total) * 100;
    return (
      <span
        key={cls}
        className={`cb-seg ${cls}`}
        style={{ width: `${pct}%` }}
        title={`${label}: ${fmtCost(val)} (${pct.toFixed(0)}%)`}
      />
    );
  };
  return (
    <div className="cost-bar" aria-label="Cost breakdown">
      {seg(cost.input, "cb-input", "input")}
      {seg(cost.output, "cb-output", "output")}
      {seg(cost.cacheRead, "cb-cache-r", "cache read")}
      {seg(cost.cacheWrite, "cb-cache-w", "cache write")}
    </div>
  );
}

// ── Codex usage row (token counts, no cap → no %) ─────────────────────────
function CodexUsageRow({ label, win }: { label: string; win: { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number; sessionCount: number } }) {
  const total = win.totalTokens;
  if (total === 0) {
    return (
      <div className="qb-row">
        <div className="qb-meta">
          <span className="qb-label">{label}</span>
          <span className="qb-pct" style={{ color: "var(--fg-dim)" }}>no sessions</span>
        </div>
      </div>
    );
  }
  const sessions = win.sessionCount;
  return (
    <div className="qb-row">
      <div className="qb-meta">
        <span className="qb-label">{label}</span>
        <span className="qb-pct" style={{ color: "var(--accent)" }}>{fmtTokens(total)}</span>
      </div>
      <div className="qb-track">
        {/* Visual bar: split by input vs output+cache */}
        <div
          className="qb-fill"
          style={{
            width: `${Math.min(100, (win.inputTokens / Math.max(1, total)) * 100)}%`,
            background: "var(--accent)",
          }}
        />
      </div>
      <div className="qb-reset">
        {fmtTokens(win.inputTokens)} in · {fmtTokens(win.outputTokens)} out
        {win.cacheReadTokens > 0 && ` · ${fmtTokens(win.cacheReadTokens)} cached`}
        {` · ${sessions} session${sessions !== 1 ? "s" : ""}`}
      </div>
    </div>
  );
}

// ── Quota bar ──────────────────────────────────────────────────────────────
function QuotaBar({ pct, label, reset, warn }: { pct: number; label: string; reset?: string; warn?: boolean }) {
  const capped = Math.min(100, Math.max(0, pct));
  const color = capped >= 90 ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  return (
    <div className="qb-row">
      <div className="qb-meta">
        <span className="qb-label">{label}</span>
        <span className="qb-pct" style={{ color }}>{capped}%</span>
      </div>
      <div className="qb-track">
        <div className="qb-fill" style={{ width: `${capped}%`, background: color }} />
      </div>
      {reset && <div className="qb-reset">resets {reset}</div>}
    </div>
  );
}

// ── Quota fetch hook ───────────────────────────────────────────────────────
const QUOTA_POLL_MS = 120_000; // match server cache TTL

function useQuota() {
  const [quota, setQuota] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/quota");
      if (res.ok) setQuota(await res.json());
    } catch { /* server unreachable */ }
    finally { if (!silent) setLoading(false); }
  };

  useEffect(() => {
    fetch_();
    timerRef.current = window.setInterval(() => fetch_(true), QUOTA_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, []);

  const refresh = () => fetch_();
  return { quota, loading, refresh };
}

// ── Codex usage types + hook ───────────────────────────────────────────────
interface CodexWindow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  sessionCount: number;
}
interface CodexUsageData {
  ok: boolean;
  window5h?: CodexWindow;
  window7d?: CodexWindow;
  fetchedAt?: number;
}

const CODEX_POLL_MS = 60_000;

function useCodexUsage() {
  const [data, setData] = useState<CodexUsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<number | null>(null);

  const fetch_ = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/codex-usage");
      if (res.ok) setData(await res.json());
    } catch { /* server unreachable */ }
    finally { if (!silent) setLoading(false); }
  };

  useEffect(() => {
    fetch_();
    timerRef.current = window.setInterval(() => fetch_(true), CODEX_POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, []);

  const refresh = () => fetch_();
  return { data, loading, refresh };
}

interface Props {
  state: GraphState;
  now: number;
  onClose: () => void;
}

export default function UsagePanel({ state, now, onClose }: Props) {
  const { quota, loading: quotaLoading, refresh: refreshQuota } = useQuota();
  const { data: codexUsage, loading: codexLoading, refresh: refreshCodex } = useCodexUsage();
  const { byModel, totalCost, totalTokens, burnRate } = useMemo(() => {
    const modelMap = new Map<string, ModelRow>();
    const totalCostAcc: CostBreakdown = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheC = 0;

    for (const a of state.agents.values()) {
      const key = a.model ?? "__unknown__";
      const c = costForUsage(a.usage, a.model);
      const row = modelMap.get(key);
      if (row) {
        row.inputTokens        += a.usage.inputTokens;
        row.outputTokens       += a.usage.outputTokens;
        row.cacheReadTokens    += a.usage.cacheReadTokens;
        row.cacheCreateTokens  += a.usage.cacheCreateTokens;
        row.cost.total         += c.total;
        row.cost.input         += c.input;
        row.cost.output        += c.output;
        row.cost.cacheRead     += c.cacheRead;
        row.cost.cacheWrite    += c.cacheWrite;
        row.agentCount++;
      } else {
        modelMap.set(key, {
          model: key,
          inputTokens:       a.usage.inputTokens,
          outputTokens:      a.usage.outputTokens,
          cacheReadTokens:   a.usage.cacheReadTokens,
          cacheCreateTokens: a.usage.cacheCreateTokens,
          cost: { ...c },
          agentCount: 1,
        });
      }
      totalCostAcc.total     += c.total;
      totalCostAcc.input     += c.input;
      totalCostAcc.output    += c.output;
      totalCostAcc.cacheRead += c.cacheRead;
      totalCostAcc.cacheWrite += c.cacheWrite;
      totalIn    += a.usage.inputTokens;
      totalOut   += a.usage.outputTokens;
      totalCacheR += a.usage.cacheReadTokens;
      totalCacheC += a.usage.cacheCreateTokens;
    }

    const byModel = Array.from(modelMap.values()).sort((a, b) => b.cost.total - a.cost.total);

    let liveCost = 0, liveSec = 0;
    for (const a of state.agents.values()) {
      if (a.state !== "active") continue;
      const c = costForUsage(a.usage, a.model);
      liveCost += c.total;
      liveSec = Math.max(liveSec, ((a.endedAt ?? now) - a.startedAt) / 1000);
    }
    const burnRate = liveSec > 0 ? fmtCostRate(liveCost, liveSec) : null;

    return {
      byModel,
      totalCost: totalCostAcc,
      totalTokens: { in: totalIn, out: totalOut, cacheR: totalCacheR, cacheC: totalCacheC },
      burnRate,
    };
  }, [state, state.lastSeq, now]);

  const bySessions = useMemo((): SessionRow[] => {
    const roots: SessionRow[] = [];
    for (const a of state.agents.values()) {
      if (a.kind !== "root") continue;
      let cost = costForUsage(a.usage, a.model).total;
      let inT = a.usage.inputTokens, outT = a.usage.outputTokens;
      for (const sub of state.agents.values()) {
        if (sub.sessionId !== a.sessionId || sub.kind === "root") continue;
        cost += costForUsage(sub.usage, sub.model).total;
        inT  += sub.usage.inputTokens;
        outT += sub.usage.outputTokens;
      }
      roots.push({
        sessionId: a.sessionId,
        label: a.label || a.cwdBasename || "session",
        state: a.state,
        cost,
        inputTokens: inT,
        outputTokens: outT,
      });
    }
    return roots.sort((a, b) => b.cost - a.cost).slice(0, 12);
  }, [state, state.lastSeq]);

  const hasCost = totalCost.total > 0;
  const totalTokenSum = totalTokens.in + totalTokens.out;

  return (
    <div className="usage-panel" aria-label="Usage">
      <div className="up-header">
        <h3>Usage</h3>
        {burnRate && <span className="up-rate">{burnRate}</span>}
        <button
          type="button"
          className="btn icon-btn up-close"
          onClick={onClose}
          aria-label="Close usage panel"
          title="Close (U)"
        >×</button>
      </div>

      {/* ── Claude quota ── */}
      <section className="up-section up-quota-section">
        <div className="up-quota-header">
          <h4 className="up-section-title" style={{ margin: 0 }}>Claude quota</h4>
          <button
            type="button"
            className="btn up-refresh-btn"
            onClick={refreshQuota}
            disabled={quotaLoading}
            title="Re-fetch quota from claude CLI"
          >{quotaLoading ? "…" : "↻"}</button>
        </div>
        {quota?.ok ? (
          <div className="up-quota-bars">
            {quota.session5hPct != null && (
              <QuotaBar
                label="5-hour window"
                pct={quota.session5hPct}
                reset={quota.session5hReset}
              />
            )}
            {quota.week7dPct != null && (
              <QuotaBar
                label="7-day window"
                pct={quota.week7dPct}
                reset={quota.week7dReset}
              />
            )}
            {quota.weekSonnetPct != null && (
              <QuotaBar label="Sonnet (7d)" pct={quota.weekSonnetPct} />
            )}
            {quota.weekOpusPct != null && (
              <QuotaBar label="Opus (7d)" pct={quota.weekOpusPct} />
            )}
          </div>
        ) : quota?.ok === false ? (
          <div className="up-quota-na">
            <span>Quota unavailable.</span>
            <span className="up-quota-hint">Run <code>/usage</code> in a claude session, then click ↻</span>
          </div>
        ) : (
          <div className="up-quota-na up-quota-loading">Checking…</div>
        )}
      </section>

      {/* ── Codex usage ── */}
      <section className="up-section up-quota-section">
        <div className="up-quota-header">
          <h4 className="up-section-title" style={{ margin: 0 }}>Codex usage</h4>
          <button
            type="button"
            className="btn up-refresh-btn"
            onClick={refreshCodex}
            disabled={codexLoading}
            title="Re-scan Codex session files"
          >{codexLoading ? "…" : "↻"}</button>
        </div>
        {codexUsage?.ok ? (
          <div className="up-quota-bars">
            <CodexUsageRow label="5-hour window" win={codexUsage.window5h!} />
            <CodexUsageRow label="7-day window"  win={codexUsage.window7d!} />
          </div>
        ) : codexUsage?.ok === false ? (
          <div className="up-quota-na">No Codex sessions found.</div>
        ) : (
          <div className="up-quota-na up-quota-loading">Checking…</div>
        )}
      </section>

      {/* ── Cost + tokens ── */}
      {hasCost ? (
        <>
          <div className="up-total">
            <span className="up-total-value">{fmtCost(totalCost.total)}</span>
            <span className="up-total-label">total spend</span>
          </div>
          <CostBar cost={totalCost} />

          {totalTokenSum > 0 && (
            <div className="up-tokens-row">
              <span className="up-tok"><span className="up-k">in</span>{fmtTokens(totalTokens.in)}</span>
              <span className="up-tok"><span className="up-k">out</span>{fmtTokens(totalTokens.out)}</span>
              {totalTokens.cacheR > 0 && <span className="up-tok"><span className="up-k">cache r</span>{fmtTokens(totalTokens.cacheR)}</span>}
              {totalTokens.cacheC > 0 && <span className="up-tok"><span className="up-k">cache c</span>{fmtTokens(totalTokens.cacheC)}</span>}
            </div>
          )}

          {byModel.filter(m => m.cost.total > 0).length > 0 && (
            <section className="up-section">
              <h4 className="up-section-title">By model</h4>
              <table className="up-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.filter(m => m.cost.total > 0).map(m => (
                    <tr key={m.model}>
                      <td className="up-model-name" title={m.model}>{shortModel(m.model)}</td>
                      <td className="up-num">{fmtTokens(m.inputTokens + m.outputTokens)}</td>
                      <td className="up-num up-cost-val">{fmtCost(m.cost.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {bySessions.filter(s => s.cost > 0).length > 0 && (
            <section className="up-section">
              <h4 className="up-section-title">By session</h4>
              <div className="up-sessions">
                {bySessions.filter(s => s.cost > 0).map(s => (
                  <div className="up-session-row" key={s.sessionId}>
                    <span className={`sl-dot state-${s.state}`} aria-hidden />
                    <span className="up-session-label">{s.label}</span>
                    <span className="up-session-tokens">{fmtTokens(s.inputTokens + s.outputTokens)}</span>
                    <span className="up-session-cost">{fmtCost(s.cost)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : totalTokenSum > 0 ? (
        <>
          <div className="up-tokens-row">
            <span className="up-tok"><span className="up-k">in</span>{fmtTokens(totalTokens.in)}</span>
            <span className="up-tok"><span className="up-k">out</span>{fmtTokens(totalTokens.out)}</span>
          </div>
          <div className="up-hint">Cost appears once a known model is detected.</div>
        </>
      ) : (
        <div className="up-empty">No usage data yet.<br />Start a Claude Code or Codex session.</div>
      )}
    </div>
  );
}
