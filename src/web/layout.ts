// Auto-layout helper using dagre. Pure: input nodes/edges -> positioned nodes.
import dagre from "dagre";
import type { Node, Edge } from "reactflow";

const NODE_W = 240;
const NODE_H = 130;

export interface LayoutOptions {
  direction?: "LR" | "TB";
  /** Nodes the user has dragged — keep their position; don't re-layout. */
  pinned?: Map<string, { x: number; y: number }>;
}

export function autoLayout(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): Node[] {
  const direction = opts.direction ?? "LR";
  const pinned = opts.pinned ?? new Map();

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    marginx: 60,
    marginy: 60,
    nodesep: 70,    // gap between sibling nodes
    ranksep: 160,   // gap between ranks (parent → child distance)
    edgesep: 30,
  });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map(n => {
    const manual = pinned.get(n.id);
    if (manual) return { ...n, position: manual };
    const p = g.node(n.id);
    if (!p) return n;
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}
