// Event → graph reducer. Pure-ish: same events in any order = same end state.
import type { AgentNodeData, HookEnvelope, HookPayload, ToolCall } from "./types";

export interface GraphState {
  agents: Map<string, AgentNodeData>;
  toolIndex: Map<string, ToolCall>;
  lastSeq: number;
  totalEvents: number;
}

export function initialState(): GraphState {
  return {
    agents: new Map(),
    toolIndex: new Map(),
    lastSeq: 0,
    totalEvents: 0,
  };
}

function basename(p?: string): string | undefined {
  if (!p) return undefined;
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function agentIdFor(p: HookPayload): string {
  const session = p.session_id ?? "unknown";
  const parent = p.parent_tool_use_id;
  return parent ? `${session}::${parent}` : session;
}

function parentAgentIdFor(p: HookPayload): string | undefined {
  return p.parent_tool_use_id ? p.session_id : undefined;
}

function ensureAgent(state: GraphState, p: HookPayload, now: number): AgentNodeData {
  const id = agentIdFor(p);
  let a = state.agents.get(id);
  if (a) {
    // Late-arriving cwd / subagent_type fills in.
    if (!a.cwd && p.cwd) { a.cwd = p.cwd; a.cwdBasename = basename(p.cwd); }
    if (a.kind === "subagent" && p.subagent_type && (a.label === "subagent" || !a.label)) a.label = p.subagent_type;
    return a;
  }

  const isSub = !!p.parent_tool_use_id;
  const session = p.session_id ?? "unknown";
  a = {
    id,
    sessionId: session,
    label: isSub ? (p.subagent_type ?? "subagent") : (basename(p.cwd) ?? "session"),
    kind: isSub ? "subagent" : "root",
    parentId: parentAgentIdFor(p),
    state: "active",
    startedAt: now,
    tools: [],
    cwd: p.cwd,
    cwdBasename: basename(p.cwd),
    toolCount: 0,
  };
  state.agents.set(id, a);
  return a;
}

function shortPreview(input: any, max = 80): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > max ? input.slice(0, max - 1) + "…" : input;
  try {
    const s = JSON.stringify(input);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  } catch {
    return String(input);
  }
}

export function applyEvent(state: GraphState, env: HookEnvelope): GraphState {
  if (env.seq <= state.lastSeq) return state;

  const p = env.payload ?? {};
  const now = env.receivedAt;
  const name = p.hook_event_name ?? "Unknown";

  if (name === "__clear") {
    return { ...initialState(), lastSeq: env.seq };
  }

  state.totalEvents += 1;
  state.lastSeq = env.seq;

  const a = ensureAgent(state, p, now);

  switch (name) {
    case "SessionStart": {
      a.state = "active";
      a.startedAt = a.startedAt || now;
      break;
    }
    case "UserPromptSubmit": {
      a.state = "active";
      if (!a.firstPrompt) a.firstPrompt = shortPreview(p.prompt ?? p.message, 120);
      break;
    }
    case "PreToolUse": {
      const id = p.tool_use_id ?? `${a.id}:${a.toolCount}`;
      const tc: ToolCall = {
        id,
        name: p.tool_name ?? "?",
        inputPreview: shortPreview(p.tool_input),
        startedAt: now,
      };
      a.tools.push(tc);
      a.toolCount += 1;
      a.state = "active";
      state.toolIndex.set(id, tc);
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const id = p.tool_use_id;
      const tc = id ? state.toolIndex.get(id) : undefined;
      if (tc) {
        tc.endedAt = now;
        tc.ok = name === "PostToolUse";
        if (name === "PostToolUseFailure") tc.errorPreview = shortPreview(p.tool_response);
        state.toolIndex.delete(id!);
      }
      break;
    }
    case "SubagentStart": {
      a.state = "active";
      a.startedAt = a.startedAt || now;
      if (p.subagent_type) a.label = p.subagent_type;
      break;
    }
    case "SubagentStop": {
      a.state = "done";
      a.endedAt = now;
      break;
    }
    case "Stop":
    case "SessionEnd": {
      a.state = "done";
      a.endedAt = now;
      break;
    }
    case "Notification": {
      break;
    }
  }

  return state;
}

/** Deterministic per-session hue (0–360). Used to give each session a calm accent. */
export function sessionHue(sessionId: string): number {
  let h = 5381;
  for (let i = 0; i < sessionId.length; i++) h = ((h << 5) + h) ^ sessionId.charCodeAt(i);
  return Math.abs(h) % 360;
}
