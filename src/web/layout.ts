// Auto-layout helper using dagre. Pure: input nodes/edges -> positioned nodes.
import dagre from "dagre";
import type { Node, Edge } from "reactflow";

const NODE_W = 240;
const NODE_H = 130;

export interface LayoutOptions {
  direction?: "LR" | "TB";
  /** Nodes the user has dragged — keep their position; don't re-layout. */
  pinned?: Map<string, { x: number; y: number }>;
  /** Real per-node sizes (measured by React Flow). Overrides defaults. */
  measured?: Map<string, { width: number; height: number }>;
}

export function autoLayout(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): Node[] {
  const direction = opts.direction ?? "LR";
  const pinned = opts.pinned ?? new Map();
  const measured = opts.measured ?? new Map();

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

  for (const n of nodes) {
    const m = measured.get(n.id);
    g.setNode(n.id, { width: m?.width ?? NODE_W, height: m?.height ?? NODE_H });
  }
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map(n => {
    const manual = pinned.get(n.id);
    if (manual) return { ...n, position: manual };
    const p = g.node(n.id);
    if (!p) return n;
    const m = measured.get(n.id);
    const w = m?.width ?? NODE_W;
    const h = m?.height ?? NODE_H;
    return { ...n, position: { x: p.x - w / 2, y: p.y - h / 2 } };
  });
}
