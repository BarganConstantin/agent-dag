// Auto-layout helper using dagre. Pure: input nodes/edges -> positioned nodes.
import dagre from "dagre";
import type { Node, Edge } from "reactflow";

const NODE_W = 200;
const NODE_H = 70;

export function autoLayout(nodes: Node[], edges: Edge[], direction: "LR" | "TB" = "LR"): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, marginx: 40, marginy: 40, nodesep: 40, ranksep: 80 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map(n => {
    const p = g.node(n.id);
    if (!p) return n;
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}
