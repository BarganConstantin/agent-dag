// Shared types between client modules.

export type AgentState = "active" | "done" | "err";

export interface ToolCall {
  id: string;                 // tool_use_id when available, else generated
  name: string;
  inputPreview: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  errorPreview?: string;
}

export interface AgentNodeData {
  id: string;                 // session_id or `${session}::${parent_tool_use_id}`
  label: string;              // human label (e.g., "main", "Explore", "Bash")
  kind: "root" | "subagent";
  parentId?: string;
  state: AgentState;
  startedAt: number;
  endedAt?: number;
  tools: ToolCall[];
  cwd?: string;
  toolCount: number;
}

export interface HookEnvelope {
  seq: number;
  receivedAt: number;
  source: string;
  payload: HookPayload;
}

/** Loose shape — different Claude Code hook events deliver different keys. */
export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  tool_use_id?: string;
  parent_tool_use_id?: string;
  subagent_type?: string;
  message?: string;
  prompt?: string;
  [key: string]: any;
}
