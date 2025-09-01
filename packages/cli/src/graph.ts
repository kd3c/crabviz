import { Graph } from "graphlib";
import { Edge, GraphData, NodeInfo } from "./types.js";

export function mergeGraphs(parts: { nodes: NodeInfo[]; edges: Edge[] }[]): GraphData {
  const nodes: NodeInfo[] = [];
  const edges: Edge[] = [];
  for (const p of parts) {
    nodes.push(...p.nodes);
    edges.push(...p.edges);
  }
  return { nodes, edges };
}

export function sanitizeGraph(g: GraphData): GraphData {
  const nodeIds = new Set(g.nodes.map(n => n.id));
  const edges = g.edges.filter(
    e => typeof e.from === "string" &&
         typeof e.to === "string" &&
         e.from && e.to &&
         nodeIds.has(e.from) &&
         nodeIds.has(e.to)
  );
  return { nodes: g.nodes, edges };
}


export function toDot(gd: GraphData, simplified = false): string {
  const g = new Graph({ directed: true });

  if (simplified) {
    const map = new Map<string, string>(); // file -> bucket
    for (const n of gd.nodes) {
      const bucket = n.id.replace(/\\/g, "/").split("/").slice(0, 2).join("/");
      map.set(n.id, bucket);
      g.setNode(bucket);
    }
    for (const e of gd.edges) {
      const a = map.get(e.from)!;
      const b = map.get(e.to) ?? e.to;
      if (a && b && a !== b) g.setEdge(a, b, e.kind);
    }
  } else {
    for (const n of gd.nodes) g.setNode(n.id);
    for (const e of gd.edges) g.setEdge(e.from, e.to, e.kind);
  }

  const nodes = g.nodes().map((id: string) => `  "${id}"`);
  const edges = g.edges().map((e: { v: string; w: string }) => `  "${e.v}" -> "${e.w}"`);

  return `digraph G {
  rankdir=LR;
${nodes.join("\n")}
${edges.length ? "\n" : ""}${edges.join("\n")}
}
`;
}
