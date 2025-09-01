// Port of webview-ui/src/graph/graphviz.ts for parity in CLI
import { Graph as VizGraph } from '@viz-js/viz';
import { Graph, File, Symbol, Relation, RelationKind } from './ui-graph-types.js';
import { escapeHtml, commonAncestorPath, splitDirectory } from './ui-utils.js';

type Node = { name:string; attributes: Record<string, any>; dir:string; };
type Subgraph = { name:string; nodes:Node[]; subgraphs:Subgraph[]; graphAttributes:Record<string,any>; dir:string; };
type Edge = { tail:string; head:string; attributes: Record<string, any>; };

export function convertUiGraph(graph:Graph, root:string, collapse:boolean): VizGraph {
  // Ensure DOMParser (jsdom) present for strictParseOk validation in Node environment
  if (!(globalThis as any).DOMParser) {
    try {
      const { JSDOM } = require('jsdom');
      const { window } = new JSDOM('<!doctype html><html><body></body></html>');
      (globalThis as any).window = window;
      (globalThis as any).document = window.document;
      (globalThis as any).DOMParser = window.DOMParser;
    } catch { /* non-fatal */ }
  }
  const nodes = graph.files
    .sort((a,b)=> a.path.localeCompare(b.path))
    .map(f=> file2node(f, collapse));

  let subgraph = nodes.reduce<Subgraph|undefined>((sg,node)=> {
    if (!sg) { const created = createSubgraph(node.dir); created.nodes.push(node); return created; }
    const ancestor = commonAncestorPath(sg.dir, node.dir);
    if (sg.dir.length !== ancestor.length) sg = createSubgraph(ancestor, sg);
    findAncestor: for (let it = sg, dir = node.dir;;) {
      if (dir === it.dir) { it.nodes.push(node); break; }
      dir = dir.substring(it.dir.length + 1);
      for (const child of it.subgraphs) {
        if (dir.startsWith(child.dir)) { it = child; continue findAncestor; }
      }
      const child = createSubgraph(dir); child.nodes.push(node); it.subgraphs.push(child); break;
    }
    return sg;
  }, undefined);

  if (subgraph) {
    const [rootParent] = splitDirectory(root);
    subgraph.dir = subgraph.dir.substring(rootParent.length + 1);
    subgraph.graphAttributes.label = { html: subgraphTitle(subgraph.dir) };
  }

  return {
    graphAttributes: { rankdir:'LR', ranksep:2.0, fontsize:'16', fontname:'Arial', label:'' },
    nodeAttributes: { fontsize:'16', fontname:'Arial', shape:'plaintext', style:'filled' },
    edgeAttributes: { arrowsize:'1.5', label:' ' },
    subgraphs: subgraph? [subgraph]: [],
    edges: collectEdges(graph.relations, collapse)
  } as unknown as VizGraph;
}

const createSubgraph = (function(){ let count=0; return (dir:string, existing?:Subgraph): Subgraph => {
  if (existing) { existing.dir = existing.dir.substring(dir.length+1); existing.graphAttributes.label = { html: subgraphTitle(existing.dir) }; }
  count++; return { name:`cluster_${count}`, nodes:[], subgraphs: existing? [existing]:[], graphAttributes:{ label:{ html: subgraphTitle(dir) } }, dir };
};})();

// Keep sanitization minimal; Graphviz HTML-like labels can be sensitive to overly aggressive whitespace removal.
function sanitizeHtmlLabel(html:string){
  // Preserve leading/trailing newlines to stay closest to webview-ui original (avoid potential Graphviz quirks).
  return html.replace(/\r/g,'');
}
function subgraphTitle(t:string){ return sanitizeHtmlLabel(`<TABLE BORDER="0" BGCOLOR="lightgray" CELLPADDING="6" CELLBORDER="0"><TR><TD>${escapeHtml(t)}</TD></TR></TABLE>`); }

function file2node(file:File, collapsed:boolean): Node {
  const [dir, name] = splitDirectory(file.path);
  const id = file.id.toString();
  // Normalize path to forward slashes for parity with webview which runs in browser (avoids potential HTML-like parsing quirks)
  const hrefPath = file.path.replace(/\\/g,'/');
  const labelHtmlRaw = collapsed || file.symbols.length<=0 ?
    `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4">
            <TR><TD HREF="${hrefPath}" WIDTH="200" BORDER="0" CELLPADDING="6">
            ${escapeHtml(name)}
            </TD></TR>
          </TABLE>`:
    `
          <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4">
            <TR><TD HREF="${hrefPath}" WIDTH="230" BORDER="0" CELLPADDING="6">
            ${escapeHtml(name)}
            </TD></TR>
            ${file.symbols.map(s=> symbol2cell(file.id,s)).join("\n")}
            <TR><TD CELLSPACING="0" HEIGHT="1" WIDTH="1" FIXEDSIZE="TRUE" STYLE="invis"></TD></TR>
          </TABLE>
        `;
  const labelHtml = sanitizeHtmlLabel(labelHtmlRaw);
  const validStruct = validateHtmlLike(labelHtml);
  const validStrict = strictParseOk(labelHtml);
  (file as any).__crvLabel = labelHtml; // store for later debug validation run
  if (!validStruct || !validStrict) console.error('[label-invalid]', { path:file.path, validStruct, validStrict, preview: labelHtml.slice(0,160) });
  // As a last resort (very rare), if strict parsing fails we fallback to a minimal label with just filename.
  if (!validateHtmlLike(labelHtml) && !strictParseOk(labelHtml)) {
    const safe = `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4"><TR><TD HREF="${hrefPath}" WIDTH="200" BORDER="0" CELLPADDING="6">${escapeHtml(name)}</TD></TR></TABLE>`;
    return { name:id, attributes:{ id, label:{ html: safe } }, dir };
  }
  return { name:id, attributes:{ id, label:{ html: labelHtml } }, dir };
}

function symbol2cell(fileId:number, s:Symbol): string {
  const text = escapeHtml(s.name); const port = `${s.range.start.line}_${s.range.start.character}`; const href = `HREF="${s.kind}"`;
  let icon='';
  switch (s.kind) { case 5: icon='C'; break; case 23: icon='S'; break; case 10: icon='E'; break; case 26: icon='T'; break; case 8: icon='f'; break; case 7: icon='p'; break; default: break; }
  if (icon.length) icon = `<B>${icon}</B>  `;
  if (!s.children.length) return `<TR><TD PORT="${port}" ID="${fileId}:${port}" ${href} BGCOLOR="blue">${icon}${text}</TD></TR>`;
  const childHtml = s.children.map(c=> symbol2cell(fileId,c)).join("\n");
  return `
    <TR><TD CELLPADDING="0">
    <TABLE ID="${fileId}:${port}" ${href} BORDER="0" CELLSPACING="8" CELLPADDING="4" CELLBORDER="0" BGCOLOR="green">
    <TR><TD PORT="${port}">${icon}${text}</TD></TR>
    ${childHtml}
    </TABLE>
    </TD></TR>
  `;
}

function collectEdges(rel:Relation[], collapse:boolean): Edge[] {
  if (!collapse) return rel.map(r=> ({ tail:`${r.from.fileId}`, head:`${r.to.fileId}`, attributes:{ id:`${r.from.fileId}:${r.from.line}_${r.from.character}-${r.to.fileId}:${r.to.line}_${r.to.character}`, tailport:`${r.from.line}_${r.from.character}`, headport:`${r.to.line}_${r.to.character}`, class: r.kind===RelationKind.Impl? 'impl': '' } }));
  const map = new Map<string,Edge>();
  for (const r of rel){ const tail = r.from.fileId.toString(); const head = r.to.fileId.toString(); const cls = r.kind===RelationKind.Impl? 'impl': ''; const id = `${tail}:${cls}-${head}:`; if (!map.has(id)) map.set(id,{ tail, head, attributes:{ id, class: cls } }); }
  return Array.from(map.values());
}

// Simple validator for Graphviz HTML-like subset (ensures tag stack matches for TABLE/TR/TD/B tags only)
function validateHtmlLike(html:string): boolean {
  const stack: string[] = [];
  const tagRe = /<\/?([A-Z]+)(?:\s+[^>]*)?>/g; // uppercase tags
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const full = m[0];
    const closing = full.startsWith('</');
    const tag = m[1];
    if (closing) {
      const top = stack.pop();
      if (top !== tag) return false;
    } else if (!full.endsWith('/>')) {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

// Extra runtime validation using DOMParser (strict XHTML) to catch malformed label fragments early when debugging.
function strictParseOk(html:string): boolean {
  if (!(globalThis as any).DOMParser) return true;
  try {
    const doc = new (globalThis as any).DOMParser().parseFromString(`<div>${html}</div>`, 'application/xhtml+xml');
    // jsdom signals parse errors by injecting <parsererror>
    return !doc.querySelector('parsererror');
  } catch { return false; }
}
