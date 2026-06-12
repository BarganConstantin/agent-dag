import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { AgentNodeData } from "../types";

export default function AgentNode({ data, selected }: NodeProps<AgentNodeData>) {
  const cls = [
    "agent-node",
    `state-${data.state}`,
    selected ? "selected" : "",
  ].filter(Boolean).join(" ");

  const inflightCount = data.tools.filter(t => !t.endedAt).length;

  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} style={{ background: "transparent", border: "none" }} />
      <div className="title">{data.label}</div>
      <div className="sub">{data.kind === "root" ? "session" : "subagent"}</div>
      <div className="meta">
        <span><b>{data.toolCount}</b> tools</span>
        {inflightCount > 0 && <span><b>{inflightCount}</b> in-flight</span>}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "transparent", border: "none" }} />
    </div>
  );
}
