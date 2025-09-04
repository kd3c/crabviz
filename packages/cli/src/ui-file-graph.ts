// Port of webview-ui/src/graph/{graphviz.ts,render.ts} simplified to file-level only
import { JSDOM } from 'jsdom';
import { instance as vizInstance } from '@viz-js/viz';
import { splitDirectory, commonAncestorPath, escapeHtml } from './ui-utils.js';

// Layout configuration (shared with symbol graph rendering)
export interface LayoutConfig { filesPerRow?: number; rankdir?: 'LR' | 'TB'; rootGrid?: { cols:number; rows:number; raw:string }; rootPaths?: string[]; symbolLayout?: 'table' | 'split' | 'cluster'; }
let layoutConfig: LayoutConfig = { filesPerRow: 0, rankdir: 'LR', rootGrid: undefined, rootPaths: [], symbolLayout: 'split' };
export function setLayoutConfig(cfg: LayoutConfig){ layoutConfig = { ...layoutConfig, ...cfg }; }
export function getLayoutConfig(): LayoutConfig { return layoutConfig; }

function ensureDom() {
  if (typeof (globalThis as any).document === 'undefined') {
    const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser });
  }
}

export interface File { id:number; path:string; symbols: any[]; }
export interface Relation { from:{ fileId:number; line:number; character:number }; to:{ fileId:number; line:number; character:number }; kind:number; }
export interface Graph { files: File[]; relations: Relation[]; }

const REL_CALL = 0;

export function buildFileGraph(paths:string[], rawEdges:{from:string; to:string}[]): Graph {
  const norm = (p:string)=> p.replace(/\\/g,'/');
  const files = Array.from(new Set(paths.map(norm))).sort();
  const fileObjs = files.map((p,i)=> ({ id:i, path:p, symbols:[] as any[] }));
  const idBy = new Map(fileObjs.map(f=>[f.path,f.id] as const));
  const relations: Relation[] = [];
  for (const e of rawEdges) {
    const a = idBy.get(norm(e.from));
    const b = idBy.get(norm(e.to));
    if (a==null || b==null || a===b) continue;
    relations.push({ from:{ fileId:a,line:0,character:0}, to:{fileId:b,line:0,character:0}, kind:REL_CALL });
  }
  return { files: fileObjs, relations };
}

// --- convert (file-level only; no symbol cells) ---
export type HierNode = { id:string; dir:string; labelHtml:string };
export type HierSubgraph = { dir:string; nodes:HierNode[]; subs:HierSubgraph[] };

export function convertToHierarchy(graph:Graph): HierNode[] {
  const abs = graph.files.map(f=> f.path.replace(/\\/g,'/'));
  const prefix = longestCommonDirPrefix(abs);
  return graph.files
    .sort((a,b)=> a.path.localeCompare(b.path))
    .map(f=> {
      const norm = f.path.replace(/\\/g,'/');
      let rel = norm.startsWith(prefix) ? norm.slice(prefix.length) : norm;
      rel = rel.replace(/^\//,'');
      const lastSlash = rel.lastIndexOf('/');
      const dir = lastSlash === -1 ? '' : rel.substring(0,lastSlash);
      const name = lastSlash === -1 ? rel : rel.substring(lastSlash+1);
      return { id: f.id.toString(), dir, labelHtml: `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4"><TR><TD HREF="${f.path}" WIDTH="200" BORDER="0" CELLPADDING="6">${escapeHtml(name)}</TD></TR></TABLE>` };
    });
}

export function longestCommonDirPrefix(paths:string[]): string {
  if (!paths.length) return '';
  const split = paths.map(p=> p.split('/'));
  const first = split[0];
  let end = first.length;
  for (let i=1;i<split.length;i++) {
    let j=0; while (j<end && j<split[i].length && split[i][j]===first[j]) j++;
    end = j; if (end===0) break;
  }
  return first.slice(0,end).join('/');
}

export function buildSubgraphTree(nodes:HierNode[], _rootPath:string): HierSubgraph|undefined {
  if (!nodes.length) return undefined;
  const root: HierSubgraph = { dir:'', nodes:[], subs:[] };
  for (const n of nodes) {
    let parent = root;
    if (n.dir) {
      const parts = n.dir.split('/');
      let pathAcc = '';
      for (const part of parts) {
        pathAcc = pathAcc ? `${pathAcc}/${part}` : part;
  let next = parent.subs.find((s:HierSubgraph)=> s.dir === pathAcc);
        if (!next) { next = { dir:pathAcc, nodes:[], subs:[] }; parent.subs.push(next); }
        parent = next;
      }
    }
    parent.nodes.push(n);
  }
  return root;
}

export function emitSubgraphDOT(sg:HierSubgraph, out:string[], clusterIdRef:{v:number}) {
  if (sg.dir !== '') {
    clusterIdRef.v++;
    out.push(`subgraph cluster_${clusterIdRef.v} {`);
    out.push(`label=<${subgraphTitle(sg.dir)}>`);
  }
  for (const n of sg.nodes) out.push(`${n.id} [id="${n.id}" label=<${n.labelHtml}> shape=plaintext style=filled]`);
  // Optional horizontal packing: group nodes into ranks (only effective when rankdir=TB)
  if ((layoutConfig.filesPerRow||0) > 1 && layoutConfig.rankdir === 'TB' && sg.nodes.length > (layoutConfig.filesPerRow||0)) {
    const per = layoutConfig.filesPerRow!;
    for (let i=0;i<sg.nodes.length;i+=per){
      const chunk = sg.nodes.slice(i,i+per);
      if (chunk.length > 1) out.push(`{ rank=same; ${chunk.map(c=> c.id).join(' ')} }`);
    }
  }
  for (const child of sg.subs) emitSubgraphDOT(child, out, clusterIdRef);
  if (sg.dir !== '') out.push('}');
}

function subgraphTitle(t:string){ return `<TABLE BORDER="0" BGCOLOR="lightgray" CELLPADDING="6" CELLBORDER="0"><TR><TD>${escapeHtml(t)}</TD></TR></TABLE>`; }

function buildEdgeList(relations:Relation[], collapse:boolean): { id:string; tail:string; head:string }[] {
  if (!collapse) {
    return relations.map(r=> ({ id:`${r.from.fileId}:0_0-${r.to.fileId}:0_0`, tail:`${r.from.fileId}`, head:`${r.to.fileId}` }));
  }
  const uniq = new Map<string,{ id:string; tail:string; head:string }>();
  for (const r of relations) {
    const tail = r.from.fileId.toString(); const head = r.to.fileId.toString();
    const id = `${tail}:-${head}:`;
    if (!uniq.has(id)) uniq.set(id,{ id, tail, head });
  }
  return Array.from(uniq.values());
}

function graphToDot(graph:Graph, root:string, collapse:boolean): string {
  const nodes = convertToHierarchy(graph);
  const sub = buildSubgraphTree(nodes, root);
  const edges = buildEdgeList(graph.relations, collapse);
  const out:string[] = [];
  out.push('digraph G {');
  out.push(`rankdir=${layoutConfig.rankdir};`);
  out.push('ranksep=2.0;');
  out.push('fontsize=16; fontname=Arial;');
  if (!nodes.length) {
    out.push('empty_placeholder [label="(no files)"];');
  }
  if (sub) emitSubgraphDOT(sub, out, { v:0 });
  else {
    for (const n of nodes) out.push(`${n.id} [id="${n.id}" label=<${n.labelHtml}> shape=plaintext style=filled]`);
  }
  // Phase L1: basic horizontal placement of root clusters (files whose path starts with one of provided rootPaths)
  if (layoutConfig.rootGrid && layoutConfig.rootGrid.cols > 1 && layoutConfig.rootPaths && layoutConfig.rootPaths.length > 1) {
    // Identify top-level cluster representative nodes: choose first node within each root (if any)
    const rootReps: string[] = [];
    const norm = (p:string)=> p.replace(/\\/g,'/');
    const rootsNorm = Array.from(new Set(layoutConfig.rootPaths.map(norm))).sort();
    for (const r of rootsNorm) {
      const rep = nodes.find(n=> norm(graph.files[parseInt(n.id,10)]?.path||'').startsWith(r.replace(/\\/g,'/')));
      if (rep) rootReps.push(rep.id);
    }
    if (rootReps.length > 1) {
      // Simple: enforce same rank for all representatives to line up clusters horizontally.
      out.push(`{ rank=same; ${rootReps.join(' ')} }`);
    }
  }
  for (const e of edges) {
    // edge id formatted as tailCell-headCell similar to UI (we only have file-level cells)
    const edgeId = e.id.replace(/[:]/g,''); // simplify id for DOM id validity
    out.push(`${e.tail} -> ${e.head} [id="${e.tail}-${e.head}" label=" "];`);
  }
  out.push('}');
  const dot = out.join('\n');
  if ((process.env.CRV_DEBUG||'').includes('dot')) {
    console.error('[file-dot]\n'+dot.slice(0,2000));
  }
  return dot;
}

// --- render (ported, simplified: focus ignored) ---
export async function renderFileGraph(graph: Graph, root:string, collapse:boolean): Promise<SVGSVGElement> {
  ensureDom();
  const viz = await vizInstance();
  const dot = graphToDot(graph, root, collapse);
  try {
    const svgText: string = await viz.renderString(dot, { format: 'svg', engine: 'dot' } as any);
    const markup = svgText.replace(/<\?xml[^>]*>/g,'').trim();
    const container = document.createElement('div');
    container.innerHTML = markup;
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('No <svg> in viz output');
    const svgEl = svg as unknown as SVGSVGElement;
    // debug: log snippet of svg
    if ((process.env.CRV_DEBUG||'').includes('svg')) {
      console.error('SVG snippet:', svgEl.outerHTML.slice(0,300));
    }
    postProcessSvg(svgEl, collapse);
    return svgEl;
  } catch (e) {
    console.error('viz render error; DOT follows:\n'+dot); throw e;
  }
}

function postProcessSvg(svg: SVGSVGElement, collapse:boolean){
  // Make responsive: derive viewBox from width/height then remove absolute sizing
  const rawW = svg.getAttribute('width');
  const rawH = svg.getAttribute('height');
  const num = (v:string|null)=> v && /[0-9.]/.test(v) ? parseFloat(v) : undefined;
  const w = num(rawW||'');
  const h = num(rawH||'');
  if (w && h) {
    // Graphviz emits pt; treat as px scale 1:1 for viewBox
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    // Allow CSS to drive sizing; fallback inline style for plain file viewing
    if (!svg.getAttribute('style')) svg.setAttribute('style','width:100%;height:100vh;');
  }
  svg.classList.add('callgraph');
  // Convert node polygons first (some polygons may be degenerate; guard points length)
    // Anchor processing (flatten <a>, set ids, data-path) similar to webview UI
    svg.querySelectorAll('g.node g[id^="a_"]').forEach(g=> {
      const anchor = g.querySelector('a');
      if (anchor) {
        const href = anchor.getAttribute('xlink:href') || anchor.getAttribute('href') || '';
        // move children out
        while (anchor.firstChild) g.insertBefore(anchor.firstChild, anchor);
        anchor.remove();
        // assign id without a_ prefix
        const newId = g.id.replace(/^a_/, '');
        g.id = newId;
        const node = g.closest('.node');
        if (node && href && !/^[0-9]+$/.test(href)) node.setAttribute('data-path', href);
        // classify as title/cell placeholder (file-level only: treat as title)
        g.classList.add('title');
      }
    });

    // Convert node polygons to rects (rounded corners applied via CSS)
    svg.querySelectorAll('g.node polygon').forEach(poly=> {
      const pg = poly as unknown as SVGPolygonElement;
      if (pg.points && pg.points.length >= 3) {
        const rect = polygon2rect(pg);
        pg.parentNode!.replaceChild(rect, pg);
      }
    });

    // Cluster label polygons (not first-of-type) to rects with class cluster-label
    svg.querySelectorAll('g.cluster > polygon:not(:first-of-type)').forEach(poly=> {
      const pg = poly as unknown as SVGPolygonElement;
      if (pg.points && pg.points.length >= 3) {
        const rect = polygon2rect(pg);
        rect.classList.add('cluster-label');
        pg.parentNode!.replaceChild(rect, pg);
      }
    });
  // Attach edge data attributes from id (we set id explicitly in DOT)
  svg.querySelectorAll('g.edge').forEach(edge=> {
    const id = edge.getAttribute('id') || '';
    const parts = id.split('-');
    if (parts.length === 2) {
      edge.setAttribute('data-from', parts[0]);
      edge.setAttribute('data-to', parts[1]);
    }
    edge.querySelectorAll('path').forEach(p=> { const np = p.cloneNode() as SVGElement; np.classList.add('hover-path'); np.removeAttribute('stroke-dasharray'); p.parentNode!.appendChild(np); });
  });
  // Remove titles last
  svg.querySelectorAll('title').forEach(t=> t.remove());
  const fadedLayer = svg.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','g'); fadedLayer.id='faded-group'; svg.getElementById('graph0')!.appendChild(fadedLayer);
  const defs = svg.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','defs');
  defs.innerHTML = `<filter id="shadow"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-opacity="0.5"></filter><linearGradient id="highlightGradient"><stop offset="0%" stop-color="var(--edge-incoming-color)"/><stop offset="100%" stop-color="var(--edge-outgoing-color)"/></linearGradient>`;
  svg.appendChild(defs);
}

function polygon2rect(polygon: SVGPolygonElement): SVGRectElement {
  const p0 = polygon.points[0];
  const p2 = polygon.points[2];
  const rect = polygon.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','rect');
  rect.setAttribute('x', Math.min(p0.x, p2.x).toString());
  rect.setAttribute('y', Math.min(p0.y, p2.y).toString());
  rect.setAttribute('width', Math.abs(p0.x - p2.x).toString());
  rect.setAttribute('height', Math.abs(p0.y - p2.y).toString());
  return rect;
}

export async function generateUiStyleSvg(filePaths:string[], edges:{from:string; to:string}[], root:string, collapse:boolean): Promise<SVGSVGElement> {
  if (!filePaths.length) console.warn('generateUiStyleSvg: no file paths provided');
  const g = buildFileGraph(filePaths, edges);
  if (!g.files.length) console.warn('buildFileGraph produced 0 files');
  return renderFileGraph(g, root, collapse);
}
