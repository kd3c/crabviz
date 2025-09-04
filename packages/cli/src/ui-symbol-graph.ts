import { LspClient } from './lsp-manager.js';
import { Graph, File, Symbol, Relation, RelationKind } from './ui-graph-types.js';
import { instance as vizInstance } from '@viz-js/viz';
import { escapeHtml } from './ui-utils.js';
import { convertToHierarchy, buildSubgraphTree, emitSubgraphDOT, HierNode as FileHierNode, getLayoutConfig } from './ui-file-graph.js';
// (We previously attempted to use convertUiGraph + viz.renderSVGElement for parity, but
// encountered DOMParser strict parsing issues in Node. We now stick with DOT path.)
import { URI } from 'vscode-uri';
// Directly reuse / port UI graphviz conversion pieces for parity

export interface BuildSymbolGraphOptions { collapse:boolean; maxDepth?:number; includeImpl?:boolean; trimLastDepth?: boolean; skipCalls?: boolean; }

// 1. Build symbol-level Graph via LSP (files + symbols + relations)
export async function buildSymbolGraph(files:string[], client:LspClient, opts:BuildSymbolGraphOptions): Promise<Graph> {
  const norm = (p:string)=> p.replace(/\\/g,'/');
  const sorted = Array.from(new Set(files.map(norm))).sort();
  const idBy = new Map(sorted.map((p,i)=>[p,i] as const));
  const fileObjs: File[] = [];
  const symbolSeen = new Set<string>();

  // Pre-open documents to encourage servers to provide call hierarchy (best-effort)
  for (const p of sorted) {
    try {
      const lang = p.endsWith('.ts')||p.endsWith('.tsx')||p.endsWith('.js')||p.endsWith('.jsx') ? 'typescript' : p.endsWith('.py')? 'python':'plaintext';
      const txt = await import('node:fs/promises').then(m=> m.readFile(p,'utf8')).catch(()=> '');
      await client.didOpen(p, lang, txt);
    } catch { /* ignore */ }
  }

  for (const p of sorted) {
    let docSyms: any[]|undefined;
    for (let attempt=0; attempt<5; attempt++) {
      docSyms = await client.documentSymbols(p) as any[]|undefined;
      if (docSyms && docSyms.length>1) break;
      await new Promise(r=> setTimeout(r, 120));
    }
    const symbols = docSyms ? convertDocSymbols(docSyms, idBy.get(p)!, symbolSeen) : [];
    if ((process.env.CRV_DEBUG||'').includes('sym')) {
      console.error(`[sym] file ${p} symbols=${symbols.length}`);
    }
    fileObjs.push({ id:idBy.get(p)!, path:p, symbols });
  }

  const relations: (Relation & {_depth?:number})[] = [];
  let maxDepthSeen = 0;
  if (!opts.skipCalls && !opts.collapse) {
    // Build quick lookup for symbol by file -> list (flattened) for range matching
    const flatByFile = new Map<number, Symbol[]>();
    for (const f of fileObjs) {
      const arr: Symbol[] = [];
      for (const s of iterateSymbols(f.symbols)) arr.push(s);
      flatByFile.set(f.id, arr);
    }
    // Helper: find symbol in file covering position or matching start
    function findSymbol(fileId:number, pos:{line:number; character:number}): Symbol|undefined {
      const list = flatByFile.get(fileId); if (!list) return undefined;
      // Prefer symbol whose range encloses pos
      let best: Symbol|undefined;
      for (const s of list) {
        const r = s.range; if (!r) continue;
        if (r.start.line <= pos.line && r.end.line >= pos.line) {
          if (r.start.line === pos.line && r.start.character === pos.character) return s; // exact match fast exit
          best = best || s;
        }
      }
      if (best) return best;
      // fallback exact start line only
      return list.find(s=> s.range.start.line === pos.line);
    }
    const osIsWin = process.platform === 'win32';
    const normalizeUriPath = (p:string)=> {
      // LSP may return like /c:/path...; remove leading slash if windows drive
      if (osIsWin && /^\/[a-zA-Z]:\//.test(p)) return p.slice(1).replace(/\\/g,'/');
      return p.replace(/\\/g,'/');
    };
    const caseKey = (p:string)=> osIsWin ? p.toLowerCase() : p;
    const idByCase = new Map<string, number>();
    for (const [p,id] of idBy) idByCase.set(caseKey(p), id);
  const dedup = new Set<string>();
  const visitedIncoming = new Set<string>();
  const visitedOutgoing = new Set<string>();
  // Caches to avoid duplicate LSP round-trips per symbol anchor
  const incomingCache = new Map<string, any[]>();
  const outgoingCache = new Map<string, any[]>();
  const headKey = (filePath:string, pos:{line:number;character:number}) => `${filePath}:${pos.line}:${pos.character}`;
    function mapEndpoint(selStart:{line:number; character:number}, rawPath:string){
      // rawPath may be a URI object or string; ensure we derive a normalized fs path
      let pathStr = '';
      try {
        if (typeof rawPath === 'string' && /:/.test(rawPath) && rawPath.startsWith('file')) {
          pathStr = URI.parse(rawPath).fsPath;
        } else if (typeof rawPath === 'string') {
          // Might already be path-like
          pathStr = rawPath;
        } else if ((rawPath as any).path) {
          pathStr = (rawPath as any).path;
        }
      } catch { pathStr = String(rawPath||''); }
      const path = normalizeUriPath(pathStr);
      const fileId = idByCase.get(caseKey(path));
      if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] mapEndpoint raw=${rawPath} -> ${path} fileId=${fileId}`);
      if (fileId==null) return { fileId: undefined as unknown as number, targetSym: undefined as Symbol|undefined, pos: selStart };
      const targetSym = findSymbol(fileId, selStart);
      return { fileId, targetSym, pos: selStart };
    }
  const REL_CAP = Number(process.env.CRV_RELATION_CAP||8000);
  let callableTotal = 0; let prepareTotal = 0; let prepareWithItems = 0; let prepareEmpty = 0;
  async function processSymbol(f:File, sym:Symbol, depth=0){
      if (opts.maxDepth !== undefined && opts.maxDepth >= 0 && depth >= opts.maxDepth) return;
      if (relations.length >= REL_CAP) return;
  if (!isCallLike(sym.kind)) return; // skip non-callable symbols to reduce traversal noise
      callableTotal++;
      // retry prepareCallHierarchy with slight backoff; also try nearby lines
      const PREP_MAX = Number(process.env.CRV_PREP_MAX||5);
      const BACKOFF_MS = Number(process.env.CRV_PREP_DELAY||180);
      let items:any[] = [];
      for (let attempt=0; attempt<PREP_MAX && !items.length; attempt++) {
        const lineShift = attempt === 0 ? 0 : Math.min(3, attempt); // try up to 3 lines upwards
        const startPos = { line: Math.max(0, sym.range.start.line - lineShift), character: sym.range.start.character };
        try { items = await client.prepareCallHierarchy(f.path, startPos) || []; } catch { /* ignore */ }
        if (!items.length) await new Promise(r=> setTimeout(r, BACKOFF_MS));
      }
      prepareTotal++;
      if (items.length) prepareWithItems++; else prepareEmpty++;
      if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] prepare ${f.path} line=${sym.range.start.line} got=${items.length}`);
      const head = items.find((it:any)=> samePos(it.selectionRange?.start, sym.range.start)) || items[0];
      if (!head) return;
  await resolveIncoming(head, f, sym, depth);
  await resolveOutgoing(head, f, sym, depth);
    }
  async function resolveIncoming(head:any, f:File, sym:Symbol, depth:number){
      const hk = headKey(f.path, sym.range.start);
      let incoming:any[] | undefined = incomingCache.get(hk);
      if (incoming === undefined) {
        incoming = [];
        const INC_MAX = Number(process.env.CRV_CALL_MAX||3);
        for (let attempt=0; attempt<INC_MAX && !incoming.length; attempt++) {
          try { incoming = await client.incomingCalls(head) || []; } catch { incoming = []; }
          if (!incoming.length) await new Promise(r=> setTimeout(r, 120));
        }
        incomingCache.set(hk, incoming);
      }
      if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] incoming ${incoming.length} for ${f.path}#${sym.range.start.line}`);
      for (const call of incoming) {
        const ep = call.from; if (!ep?.uri || !ep.selectionRange?.start) continue;
        const { fileId, targetSym, pos } = mapEndpoint(ep.selectionRange.start, ep.uri.path||ep.uri);
        if (fileId==null) continue;
        const fromLine = targetSym? targetSym.range.start.line : pos.line;
        const fromChar = targetSym? targetSym.range.start.character : pos.character;
        const key = `${fileId}:${fromLine}_${fromChar}->${f.id}:${sym.range.start.line}_${sym.range.start.character}`;
        if (!dedup.has(key)) {
          dedup.add(key);
          relations.push({ from:{fileId, line:fromLine, character:fromChar}, to:{fileId:f.id, line:sym.range.start.line, character:sym.range.start.character}, kind:RelationKind.Call, _depth:depth });
          if (depth>maxDepthSeen) maxDepthSeen = depth;
        }
        const visitKey = `in:${fileId}:${fromLine}_${fromChar}`;
        if (!visitedIncoming.has(visitKey)) {
          visitedIncoming.add(visitKey);
          if (targetSym) {
            const parentFile = fileObjs.find(ff=> ff.id===fileId);
            if (parentFile) await processSymbol(parentFile, targetSym, depth+1);
          }
        }
      }
    }
    async function resolveOutgoing(head:any, f:File, sym:Symbol, depth:number){
      const hk = headKey(f.path, sym.range.start);
      let outgoing:any[] | undefined = outgoingCache.get(hk);
      if (outgoing === undefined) {
        outgoing = [];
        const OUT_MAX = Number(process.env.CRV_CALL_MAX||3);
        for (let attempt=0; attempt<OUT_MAX && !outgoing.length; attempt++) {
          try { outgoing = await client.outgoingCalls(head) || []; } catch { outgoing = []; }
          if (!outgoing.length) await new Promise(r=> setTimeout(r, 120));
        }
        outgoingCache.set(hk, outgoing);
      }
      if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] outgoing ${outgoing.length} for ${f.path}#${sym.range.start.line}`);
      for (const call of outgoing) {
        const ep = call.to; if (!ep?.uri || !ep.selectionRange?.start) continue;
        const { fileId, targetSym, pos } = mapEndpoint(ep.selectionRange.start, ep.uri.path||ep.uri);
        if (fileId==null) continue;
        const toLine = targetSym? targetSym.range.start.line : pos.line;
        const toChar = targetSym? targetSym.range.start.character : pos.character;
        const key = `${f.id}:${sym.range.start.line}_${sym.range.start.character}->${fileId}:${toLine}_${toChar}`;
        if (!dedup.has(key)) {
          dedup.add(key);
          relations.push({ from:{fileId:f.id, line:sym.range.start.line, character:sym.range.start.character}, to:{fileId, line:toLine, character:toChar}, kind:RelationKind.Call, _depth:depth });
          if (depth>maxDepthSeen) maxDepthSeen = depth;
        }
        const visitKey = `out:${fileId}:${toLine}_${toChar}`;
        if (!visitedOutgoing.has(visitKey)) {
          visitedOutgoing.add(visitKey);
          if (targetSym) {
            const parentFile = fileObjs.find(ff=> ff.id===fileId);
            if (parentFile) await processSymbol(parentFile, targetSym, depth+1);
          }
        }
      }
    }
    for (const f of fileObjs) {
      for (const sym of iterateSymbols(f.symbols)) {
        if (relations.length >= REL_CAP) break;
        await processSymbol(f, sym, 0);
      }
      if (relations.length >= REL_CAP) break;
    }
    const callCount = relations.length;
    // Interface implementation edges (Impl)
    if (opts.includeImpl !== false) {
      for (const f of fileObjs) {
      for (const sym of iterateSymbols(f.symbols)) {
        if (sym.kind !== 11 /* interface */) continue;
        // Query implementations
        let impls = await client.implementations(f.path, sym.range.start) || [];
        if (impls && !Array.isArray(impls)) impls = [impls];
        if (!impls.length) continue;
        for (const loc of impls) {
          try {
            const uriObj = (loc.uri) ? loc : (loc.targetUri ? loc : undefined);
            let uri = '';
            let selRange:any;
            if (uriObj && 'uri' in uriObj) { uri = uriObj.uri; selRange = uriObj.range || uriObj.selectionRange; }
            else if ('targetUri' in loc) { uri = loc.targetUri; selRange = loc.targetSelectionRange || loc.targetRange; }
            if (!uri || !selRange?.start) continue;
            const { fileId, targetSym, pos } = mapEndpoint(selRange.start, uri);
            if (fileId==null) continue;
            const toLine = targetSym? targetSym.range.start.line : pos.line;
            const toChar = targetSym? targetSym.range.start.character : pos.character;
            const key = `${f.id}:${sym.range.start.line}_${sym.range.start.character}->${fileId}:${toLine}_${toChar}:impl`;
            if (dedup.has(key)) continue; dedup.add(key);
            relations.push({ from:{ fileId:f.id, line:sym.range.start.line, character:sym.range.start.character }, to:{ fileId, line:toLine, character:toChar }, kind:RelationKind.Impl, _depth:0 });
          } catch {/* ignore single impl error */}
        }
      }
      }
    }
    if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] call relations=${callCount} impl relations=${relations.length-callCount} total=${relations.length}`);
  if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym:stats] callable=${callableTotal} prepareTotal=${prepareTotal} prepareWithItems=${prepareWithItems} prepareEmpty=${prepareEmpty}`);
  }
  // Optionally trim the deepest recorded depth (drop relations only at deepest level)
  let finalRelations: Relation[] = relations as Relation[];
  if (opts.trimLastDepth && maxDepthSeen>0) {
    finalRelations = relations.filter(r=> (r as any)._depth !== maxDepthSeen);
    if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] trimLastDepth applied: maxDepthSeen=${maxDepthSeen} kept=${finalRelations.length}/${relations.length}`);
  }
  return { files: fileObjs, relations: finalRelations };
}

function addCallRelation(endpoint:any, file:File, sym:Symbol, idBy:Map<string,number>, out:Relation[], incoming:boolean){
  if (!endpoint?.uri?.path || !endpoint.selectionRange?.start) return;
  const path = endpoint.uri.path.replace(/\\/g,'/');
  const fileId = idBy.get(path); if (fileId==null) return;
  const pos = endpoint.selectionRange.start;
  if (incoming) {
    out.push({ from:{fileId:fileId,line:pos.line,character:pos.character}, to:{fileId:file.id,line:sym.range.start.line,character:sym.range.start.character}, kind:RelationKind.Call });
  } else {
    out.push({ from:{fileId:file.id,line:sym.range.start.line,character:sym.range.start.character}, to:{fileId:fileId,line:pos.line,character:pos.character}, kind:RelationKind.Call });
  }
}

function samePos(a:any,b:any){ return a && b && a.line===b.line && a.character===b.character; }

function convertDocSymbols(list:any[], fileId:number, seen:Set<string>): Symbol[] {
  if ((process.env.CRV_DEBUG||'').includes('symraw')) {
    try { console.error('[symraw:listEntrySample]', JSON.stringify(list[0]).slice(0,300)); } catch {}
  }
  // If entries have 'location' field, it's a flat SymbolInformation[] list; return all as top-level.
  const flat = list.length && list[0] && list[0].location && !list[0].children;
  const converted = list.map(s=> docToSym(s,fileId,seen)).filter(Boolean) as Symbol[];
  if (flat) return converted; // already top-level
  return converted;
}
function docToSym(s:any, fileId:number, seen:Set<string>): Symbol|undefined {
  // Handle both hierarchical (DocumentSymbol) and flat (SymbolInformation) forms.
  if (!s?.selectionRange) {
    if (s?.range) s.selectionRange = s.range; // DocumentSymbol without selectionRange
    else if (s?.location?.range) s.selectionRange = s.location.range; // SymbolInformation
  }
  if (!s?.selectionRange) return undefined;
  if ((process.env.CRV_DEBUG||'').includes('symdump')) {
    console.error('[symdump] symbol raw', JSON.stringify({ name:s.name, kind:s.kind, hasRange:!!s.range, hasSel:!!s.selectionRange }));
  }
  const key = `${fileId}:${s.selectionRange.start.line}_${s.selectionRange.start.character}`;
  if (seen.has(key)) return undefined; seen.add(key);
  const children = Array.isArray(s.children)? s.children.map((c:any)=> docToSym(c,fileId,seen)).filter(Boolean) as Symbol[]: [];
  return { name: s.name||'(anonymous)', kind: s.kind??0, range: s.selectionRange, children };
}
function* iterateSymbols(list:Symbol[]): Iterable<Symbol>{ for(const s of list){ yield s; if(s.children.length) yield* iterateSymbols(s.children);} }
function isCallLike(kind:number){
  // Restrict to canonical callable kinds: function(12), method(6), constructor(9)
  return kind===12 || kind===6 || kind===9;
}

// 2. Convert Graph to DOT using same hierarchy helpers as file-level path logic
export function symbolGraphToDot(graph:Graph, _root:string, collapse:boolean, symbolDepth:number = Infinity): string {
  const cfg = getLayoutConfig();
  const layout = (cfg as any).symbolLayout || 'table';
  if ((process.env.CRV_DEBUG||'').includes('layout')) {
    console.error('[sym] symbolGraphToDot layout=', layout);
  }
  if (layout === 'split') {
    return symbolGraphToDotSplit(graph, symbolDepth);
  }
  if ((layout as any) === 'cluster') {
    return symbolGraphToDotCluster(graph, symbolDepth);
  }
  // Legacy table path
  const baseNodes = convertToHierarchy(graph as any) as FileHierNode[];
  const fileById = new Map(graph.files.map(f=> [f.id.toString(), f] as const));
  const depthByPort = new Set<string>();
  function markDepths(fileId:number, syms:Symbol[], depth:number){
    for (const s of syms){
      const port = `${fileId}:${s.range.start.line}_${s.range.start.character}`;
      if (depth <= symbolDepth) depthByPort.add(port);
      if (s.children.length) markDepths(fileId, s.children, depth+1);
    }
  }
  for (const f of graph.files) markDepths(f.id, f.symbols, 1);
  const nodes: Node[] = baseNodes.map(n=> {
    const f = fileById.get(n.id)!;
    if (!f.symbols.length || symbolDepth<=0) return n as Node;
    const headerMatch = /<TABLE[^>]*>(<TR><TD HREF=[^]*?<\/TR>)/.exec(n.labelHtml);
    const headerRow = headerMatch ? headerMatch[1] : `<TR><TD HREF="${f.path}" WIDTH="230" BORDER="0" CELLPADDING="6">${escapeHtml(f.path.split(/[\\/]/).pop()||'')}</TD></TR>`;
    const symRows = f.symbols.map(s=> symbolToCellDepth(f.id,s,1,symbolDepth, collapse)).filter(Boolean).join('\n');
    const rebuilt = `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4">\n${headerRow}\n${symRows}\n<TR><TD CELLSPACING="0" HEIGHT="1" WIDTH="1" FIXEDSIZE="TRUE" STYLE="invis"></TD></TR>\n</TABLE>`;
    return { id:n.id, dir:n.dir, labelHtml:rebuilt };
  });
  const sub = buildSubgraphTree(nodes as unknown as FileHierNode[], '');
  const edges = collectEdges(graph.relations, collapse, depthByPort, symbolDepth);
  const out:string[] = [];
  out.push('digraph G {');
  out.push(`rankdir=${cfg.rankdir||'LR'};`);
  out.push('ranksep=2.0;');
  out.push('fontsize=16; fontname="Arial";');
  out.push('node [fontsize=16 fontname="Arial" shape=plaintext style=filled];');
  out.push('edge [arrowsize=1.5 label=" "];');
  if (sub) emitSubgraphDOT(sub, out, { v:0 }); else nodes.forEach(n=> out.push(`${n.id} [id="${n.id}" label=<${n.labelHtml}> shape=plaintext style=filled]`));
  for (const e of edges){
    const attrs = [`id="${e.id}"`];
    if (e.tailport) attrs.push(`tailport="${e.tailport}"`);
    if (e.headport) attrs.push(`headport="${e.headport}"`);
    if (e.class) attrs.push(`class="${e.class}"`);
    out.push(`${e.tail} -> ${e.head} [${attrs.join(' ')} label=" "];`);
  }
  out.push('}');
  const dot = out.join('\n');
  if ((process.env.CRV_DEBUG||'').includes('dot')) console.error('[sym] table DOT sample', dot.slice(0,1200));
  return dot;
}

function symbolGraphToDotSplit(graph:Graph, symbolDepth:number): string {
  const cfg = getLayoutConfig();
  const out:string[] = [];
  out.push('digraph G {');
  out.push(`rankdir=${cfg.rankdir||'LR'};`);
  out.push('ranksep=2.0;');
  // Mitigate pathplan triangulation failures with dense intra-file edges
  out.push('splines=true; overlap=false; concentrate=true;');
  out.push('fontsize=16; fontname="Arial";');
  out.push('node [fontsize=16 fontname="Arial" shape=plaintext style=filled];');
  out.push('edge [arrowsize=1.5 label=" "];');
  // Build per-file clusters with hub + symbol nodes
  const fileHubId = (fId:number)=> `f${fId}_hub`;
  const symNodeId = (fId:number, s:Symbol)=> `f${fId}_l${s.range.start.line}c${s.range.start.character}`;
  function walkSymbols(fId:number, syms:Symbol[], depth:number, acc:Symbol[]): void {
    for (const s of syms){
      acc.push(s);
      if (s.children.length && depth < symbolDepth) walkSymbols(fId, s.children, depth+1, acc);
    }
  }
  for (const f of graph.files){
    out.push(`subgraph cluster_file_${f.id} {`);
    out.push(`label="${escapeLabel(f.path.split(/[\\/]/).pop()||'')}";`);
    out.push('style=rounded;');
    out.push(`${fileHubId(f.id)} [id="${fileHubId(f.id)}" label=<${escapeHtml(f.path.split(/[\\/]/).pop()||'')} > shape=plaintext class="fileHub" ];`);
    if (symbolDepth>0){
      const collected:Symbol[] = [];
      walkSymbols(f.id, f.symbols, 1, collected);
      for (const s of collected){
        const nodeId = symNodeId(f.id, s);
        const text = escapeHtml(s.name);
        const cls = symbolKindClass(s.kind);
        out.push(`${nodeId} [id="${nodeId}" label=<${text}> shape=plaintext class="cell ${cls}" ];`);
      }
    }
    out.push('}');
  }
  // Emit edges: map relations to hub or symbol nodes
  for (const r of graph.relations){
    const sameFile = r.from.fileId === r.to.fileId;
    const fromSym = graph.files.find(f=> f.id===r.from.fileId)?.symbols && findSymbolByPos(graph, r.from.fileId, r.from.line, r.from.character);
    const toSym   = graph.files.find(f=> f.id===r.to.fileId)?.symbols && findSymbolByPos(graph, r.to.fileId, r.to.line, r.to.character);
    const fromId = fromSym ? symNodeId(r.from.fileId, fromSym) : fileHubId(r.from.fileId);
    const toId   = toSym   ? symNodeId(r.to.fileId, toSym)     : fileHubId(r.to.fileId);
    if (fromId === toId) continue; // ignore degenerate
    const cls = (r as any).kind===RelationKind.Impl ? 'impl' : ((r as any).provenance && (r as any).provenance.startsWith('static-py') ? 'static': undefined);
    const id = `${fromId}-${toId}`;
    out.push(`${fromId} -> ${toId} [id="${id}"${cls?` class="${cls}"`:''} label=" "];`);
    // If same-file and hubs involved only (e.g., import self), skip (rare)
  }
  out.push('}');
  const dot = out.join('\n');
  if ((process.env.CRV_DEBUG||'').includes('dot')) console.error('[sym] split DOT sample', dot.slice(0,1200));
  return dot;
}

function symbolGraphToDotCluster(graph:Graph, symbolDepth:number): string {
  const cfg = getLayoutConfig();
  const out:string[] = [];
  out.push('digraph G {');
  out.push(`rankdir=${cfg.rankdir||'LR'};`);
  out.push('ranksep=2.0;');
  out.push('nodesep=0.4;');
  out.push('fontsize=16; fontname="Arial";');
  out.push('node [fontsize=16 fontname="Arial" shape=plaintext style=filled];');
  out.push('edge [arrowsize=1.2 label=" "];');
  const headerId = (fId:number)=> `f${fId}_hdr`;
  const symNodeId = (fId:number, s:Symbol)=> `f${fId}_l${s.range.start.line}c${s.range.start.character}`;
  function gather(f:File): Symbol[]{
    const acc:Symbol[]=[]; const stack=[...f.symbols];
    while(stack.length){ const s=stack.shift()!; acc.push(s); if(s.children.length && acc.length<symbolDepth*500) stack.unshift(...s.children); }
    return acc;
  }
  for (const f of graph.files){
    out.push(`subgraph cluster_file_${f.id} {`);
    out.push('style=rounded;');
    out.push(`label="${escapeLabel(f.path.split(/[\\/]/).pop()||'')}";`);
    out.push(`${headerId(f.id)} [id="${headerId(f.id)}" label=<${escapeHtml(f.path.split(/[\\/]/).pop()||'')} > shape=plaintext class="fileHub" ];`);
    if (symbolDepth>0){
      const list = gather(f).filter(()=> true);
      // vertical order: keep original order by line number
      list.sort((a,b)=> a.range.start.line - b.range.start.line);
      let prev:string|undefined;
      for (const s of list){
        const id = symNodeId(f.id,s);
        const cls = symbolKindClass(s.kind);
        const label = `<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0" CELLPADDING="4"><TR><TD>${escapeHtml(s.name)}</TD></TR></TABLE>`;
        out.push(`${id} [id="${id}" label=<${label}> shape=plaintext class="cell ${cls}" ];`);
        // Removed invisible ordering edge to avoid suppressing real call edges between same nodes
        prev = id;
      }
    }
    out.push('}');
  }
  // Edges
  for (const r of graph.relations){
    const fromSym = findSymbolByPos(graph, r.from.fileId, r.from.line, r.from.character);
    const toSym = findSymbolByPos(graph, r.to.fileId, r.to.line, r.to.character);
    const fromId = fromSym? symNodeId(r.from.fileId, fromSym) : headerId(r.from.fileId);
    const toId = toSym? symNodeId(r.to.fileId, toSym) : headerId(r.to.fileId);
    if (fromId===toId) continue;
    const cls = (r as any).kind===RelationKind.Impl ? 'impl' : ((r as any).provenance && (r as any).provenance.startsWith('static-py') ? 'static': undefined);
    out.push(`${fromId} -> ${toId} [id="${fromId}-${toId}"${cls?` class="${cls}"`:''}];`);
  }
  out.push('}');
  return out.join('\n');
}

function escapeLabel(s:string){ return s.replace(/"/g,'\\"'); }
function symbolKindClass(k:number){ switch(k){ case 12:return 'function'; case 6:return 'method'; case 9:return 'constructor'; case 11:return 'interface'; case 5:return 'class'; case 10:return 'enum'; case 8:return 'field'; case 7:return 'property'; default:return ''; } }
function findSymbolByPos(graph:Graph, fileId:number, line:number, ch:number): Symbol|undefined {
  const f = graph.files.find(ff=> ff.id===fileId); if(!f) return undefined;
  // Collect (cached) flattened symbol list for the file
  let flat: Symbol[] | undefined = (f as any)._flatSyms;
  if (!flat) {
    flat = [];
    const stack:Symbol[] = [...f.symbols];
    while(stack.length){ const s = stack.pop()!; flat.push(s); if (s.children.length) stack.push(...s.children); }
    (f as any)._flatSyms = flat;
  }
  // 1. Exact line + character match
  let exact = flat.find(s=> s.range.start.line===line && s.range.start.character===ch);
  if (exact) return exact;
  // 2. Any symbol starting at same line (ignore character differences caused by indentation / LSP variance)
  const sameLine = flat.filter(s=> s.range.start.line===line);
  if (sameLine.length === 1) return sameLine[0];
  if (sameLine.length > 1) {
    // Prefer one with closest character distance
    sameLine.sort((a,b)=> Math.abs(a.range.start.character-ch) - Math.abs(b.range.start.character-ch));
    return sameLine[0];
  }
  // 3. Enclosing range (selectionRange may point inside a function body for some servers)
  const enclosing = flat.filter(s=> s.range.start.line <= line && s.range.end.line >= line);
  if (enclosing.length === 1) return enclosing[0];
  if (enclosing.length > 1) {
    // Pick the smallest span (most specific)
    enclosing.sort((a,b)=> (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line));
    return enclosing[0];
  }
  return undefined;
}

// Types for conversion
interface Node { id:string; dir:string; labelHtml:string; }
// (Subgraph shape reused via buildSubgraphTree from ui-file-graph)
interface Edge { tail:string; head:string; id:string; tailport?:string; headport?:string; class?:string; }

// (file-level node construction reused instead of custom implementation)
function symbolToCell(fileId:number, s:Symbol): string {
  // Mirror webview-ui/src/graph/graphviz.ts symbol2cell logic (icons + nested tables)
  const text = escapeHtml(s.name);
  const port = `${s.range.start.line}_${s.range.start.character}`;
  const href = `HREF="${s.kind}"`;
  let icon = '';
  switch (s.kind) {
    case 5: icon = 'C'; break; // CLASS
    case 23: icon = 'S'; break; // STRUCT
    case 10: icon = 'E'; break; // ENUM
    case 26: icon = 'T'; break; // TYPE_PARAMETER
    case 8: icon = 'f'; break; // FIELD
    case 7: icon = 'p'; break; // PROPERTY
    default: break;
  }
  if (icon.length>0) icon = `<B>${icon}</B>  `;
  const baseId = `${fileId}:${port}`;
  if (!s.children.length) {
    return `<TR><TD PORT="${port}" ID="${baseId}" ${href} BGCOLOR="blue">${icon}${text}</TD></TR>`;
  }
  return `<TR><TD CELLPADDING="0"><TABLE ID="${baseId}" ${href} BORDER="0" CELLSPACING="8" CELLPADDING="4" CELLBORDER="0" BGCOLOR="green"><TR><TD PORT="${port}">${icon}${text}</TD></TR>${s.children.map(c=>symbolToCell(fileId,c)).join('\n')}</TABLE></TD></TR>`;
}
// Depth-limited variant
function symbolToCellDepth(fileId:number, s:Symbol, depth:number, maxDepth:number, flat:boolean): string | '' {
  const text = escapeHtml(s.name);
  const port = `${s.range.start.line}_${s.range.start.character}`;
  const href = `HREF="${s.kind}"`;
  let icon = '';
  switch (s.kind) {
    case 5: icon = 'C'; break; case 23: icon='S'; break; case 10: icon='E'; break; case 26: icon='T'; break; case 8: icon='f'; break; case 7: icon='p'; break; default: break;
  }
  if (icon.length>0) icon = `<B>${icon}</B>  `;
  const baseId = `${fileId}:${port}`;
  // Flat mode (collapsed view) always renders as single row (no nested tables)
  if (flat) {
    return `<TR><TD PORT="${port}" ID="${baseId}" ${href} BGCOLOR="blue">${icon}${text}</TD></TR>`;
  }
  if (!s.children.length || depth>=maxDepth) {
    return `<TR><TD PORT="${port}" ID="${baseId}" ${href} BGCOLOR="blue">${icon}${text}</TD></TR>`;
  }
  const childRows = s.children.map(c=> symbolToCellDepth(fileId,c,depth+1,maxDepth,false)).filter(Boolean).join('\n');
  return `<TR><TD CELLPADDING="0"><TABLE ID="${baseId}" ${href} BORDER="0" CELLSPACING="8" CELLPADDING="4" CELLBORDER="0" BGCOLOR="green"><TR><TD PORT="${port}">${icon}${text}</TD></TR>${childRows}</TABLE></TD></TR>`;
}
// Removed local tree + prefix implementations in favor of reuse.
function collectEdges(rel:Relation[], collapse:boolean, depthPorts:Set<string>, symbolDepth:number):Edge[]{
  if(!collapse){
    return rel.filter(r=> {
      if (symbolDepth===Infinity) return true;
      const fromOk = depthPorts.has(`${r.from.fileId}:${r.from.line}_${r.from.character}`);
      const toOk = depthPorts.has(`${r.to.fileId}:${r.to.line}_${r.to.character}`);
      return fromOk && toOk;
  }).map(r=> ({ tail:`${r.from.fileId}`, head:`${r.to.fileId}`, id:`${r.from.fileId}:${r.from.line}_${r.from.character}-${r.to.fileId}:${r.to.line}_${r.to.character}`, tailport:`${r.from.line}_${r.from.character}`, headport:`${r.to.line}_${r.to.character}`, class: r.kind===RelationKind.Impl?'impl': (r.provenance&& r.provenance.startsWith('static-py') ? 'static': undefined) }));
  }
  const m=new Map<string,Edge>();
  for(const r of rel){ const tail = r.from.fileId.toString(); const head = r.to.fileId.toString(); const cls = r.kind===RelationKind.Impl?'impl': (r.provenance&& r.provenance.startsWith('static-py') ? 'static': undefined); const id=`${tail}:${cls||''}-${head}:`; if(!m.has(id)) m.set(id,{tail,head,id, class:cls}); }
  return Array.from(m.values());
}

// 3. Render DOT to SVG and post-process like ui-file-graph.ts (reuse its postProcess with slight extension for cells)
export async function renderSymbolGraph(graph:Graph, root:string, collapse:boolean, symbolDepth:number=Infinity): Promise<SVGSVGElement> {
  if (typeof (globalThis as any).document === 'undefined') {
    const { JSDOM } = await import('jsdom');
    const { window } = new JSDOM('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, { window, document: window.document });
    if (!(globalThis as any).DOMParser && (window as any).DOMParser) {
      (globalThis as any).DOMParser = (window as any).DOMParser;
    }
  }
  const viz = await vizInstance();
  const dot = symbolGraphToDot(graph, root, collapse, symbolDepth);
  let svg: any;
  try {
    const svgText: string = await (viz as any).renderString(dot, { format:'svg', engine:'dot' });
    const container = (globalThis as any).document.createElement('div');
    container.innerHTML = svgText.replace(/<\?xml[^>]*>/,'');
    svg = container.querySelector('svg');
    if (!svg) throw new Error('No <svg> element produced');
  } catch (e:any) {
    console.error('[sym] renderString failed:', e?.message||e);
    throw e;
  }
  postProcess(svg as any);
  return svg as any;
}

function postProcess(svg:SVGSVGElement){
  // Responsive sizing: convert fixed pt width/height to scalable viewBox
  const rawW = svg.getAttribute('width');
  const rawH = svg.getAttribute('height');
  const num = (v:string|null)=> v && /[0-9.]/.test(v) ? parseFloat(v) : undefined;
  const w = num(rawW||'');
  const h = num(rawH||'');
  if (w && h) {
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    if (!svg.getAttribute('style')) svg.setAttribute('style','width:100%;height:100vh;');
  }
  svg.classList.add('callgraph');
  svg.querySelectorAll('title').forEach(t=> t.remove());
  // Flatten anchors; classify title vs cell like UI's render.ts
  svg.querySelectorAll('g[id^="a_"]').forEach(g=> {
    const anchor = g.querySelector('a'); if(!anchor) return;
    const href = anchor.getAttribute('xlink:href')||anchor.getAttribute('href')||'';
    while(anchor.firstChild) g.insertBefore(anchor.firstChild, anchor);
    anchor.remove();
    g.id = g.id.replace(/^a_/,'');
    const kindNum = parseInt(href);
    if (isNaN(kindNum)) { g.classList.add('title'); g.closest('.node')?.setAttribute('data-path', href); }
    else { g.setAttribute('data-kind', href); g.classList.add('cell'); classifyKind(g, kindNum); }
  });
  svg.querySelectorAll('g.node polygon').forEach(poly=> { const p=poly as unknown as SVGPolygonElement; p.parentNode!.replaceChild(polygon2rect(p), p); });
  svg.querySelectorAll('g.cluster > polygon:not(:first-of-type)').forEach(poly=> { const p=poly as unknown as SVGPolygonElement; const r=polygon2rect(p); r.classList.add('cluster-label'); p.parentNode!.replaceChild(r,p); });
  svg.querySelectorAll('g.edge').forEach(edge=> { const id=edge.getAttribute('id')||''; const parts=id.split('-'); if(parts.length===2){ edge.setAttribute('data-from', parts[0]); edge.setAttribute('data-to', parts[1]); }
    edge.querySelectorAll('path').forEach(path=> { const np=path.cloneNode() as SVGElement; np.classList.add('hover-path'); np.removeAttribute('stroke-dasharray'); path.parentNode!.appendChild(np); }); });
  const faded = svg.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','g'); faded.id='faded-group'; svg.getElementById('graph0')?.appendChild(faded);
  const defs = svg.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','defs'); defs.innerHTML='<filter id="shadow"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-opacity="0.5"></filter><linearGradient id="highlightGradient"><stop offset="0%" stop-color="var(--edge-incoming-color)"/><stop offset="100%" stop-color="var(--edge-outgoing-color)"/></linearGradient>'; svg.appendChild(defs);
}
function classifyKind(g:Element, k:number){ switch(k){ case 2: g.classList.add('module'); break; case 12: g.classList.add('function'); break; case 6: g.classList.add('method'); break; case 9: g.classList.add('constructor'); break; case 11: g.classList.add('interface'); break; case 8: g.classList.add('field'); break; case 7: g.classList.add('property'); break; case 5: g.classList.add('class'); break; case 10: g.classList.add('enum'); break; /* struct custom? */ default: break; } }
function polygon2rect(pg:SVGPolygonElement): SVGRectElement {
  const r = pg.ownerDocument!.createElementNS('http://www.w3.org/2000/svg','rect');
  try {
    // jsdom does not populate polygon.points; parse the attribute instead.
    const attr = pg.getAttribute('points') || '';
    const coords = attr.trim().split(/\s+/).map(pair=> pair.split(',').map(Number)).filter(a=> a.length===2 && !isNaN(a[0]) && !isNaN(a[1]));
    if (coords.length >= 2) {
      let minx=coords[0][0], maxx=coords[0][0], miny=coords[0][1], maxy=coords[0][1];
      for (const [x,y] of coords) { if (x<minx) minx=x; if (x>maxx) maxx=x; if (y<miny) miny=y; if (y>maxy) maxy=y; }
      r.setAttribute('x', String(minx));
      r.setAttribute('y', String(miny));
      r.setAttribute('width', String(maxx-minx));
      r.setAttribute('height', String(maxy-miny));
    } else {
      r.setAttribute('x','0'); r.setAttribute('y','0'); r.setAttribute('width','0'); r.setAttribute('height','0');
    }
  } catch {
    r.setAttribute('x','0'); r.setAttribute('y','0'); r.setAttribute('width','0'); r.setAttribute('height','0');
  }
  return r;
}
