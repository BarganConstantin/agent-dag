// Event → graph reducer. Pure: same events in any order = same end state.
// We accept that some CC events lack parent_tool_use_id; we infer best-effort.
import type { AgentNodeData, HookEnvelope, HookPayload, ToolCall } from "./types";

export interface GraphState {
  agents: Map<string, AgentNodeData>;
  // Per-agent in-flight tool call id set, so we can settle them on PostToolUse.
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

function agentIdFor(p: HookPayload): string {
  const session = p.session_id ?? "unknown";
  const parent = p.parent_tool_use_id;
  return parent ? `${session}::${parent}` : session;
}

function parentAgentIdFor(p: HookPayload): string | undefined {
  // Subagent rooted at parent's session.
  return p.parent_tool_use_id ? p.session_id : undefined;
}

function ensureAgent(state: GraphState, p: HookPayload, now: number): AgentNodeData {
  const id = agentIdFor(p);
  let a = state.agents.get(id);
  if (a) return a;

  const isSub = !!p.parent_tool_use_id;
  a = {
    id,
    label: isSub ? (p.subagent_type ?? "subagent") : "main",
    kind: isSub ? "subagent" : "root",
    parentId: parentAgentIdFor(p),
    state: "active",
    startedAt: now,
    tools: [],
    cwd: p.cwd,
    toolCount: 0,
  };
  state.agents.set(id, a);
  return a;
}

function shortPreview(input: any): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length > 80 ? input.slice(0, 77) + "…" : input;
  try {
    const s = JSON.stringify(input);
    return s.length > 80 ? s.slice(0, 77) + "…" : s;
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

      // Special-case: Task tool spawning a subagent — we will see SubagentStart
      // later that carries parent_tool_use_id = this id.
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
      // ensureAgent above already created the subagent node.
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
      // Mark root done.
      a.state = "done";
      a.endedAt = now;
      break;
    }
    case "Notification": {
      // No structural change yet — could surface later.
      break;
    }
  }

  return state;
}
