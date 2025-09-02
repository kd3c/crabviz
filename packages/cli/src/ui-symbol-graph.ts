import { LspClient } from './lsp-manager.js';
import { Graph, File, Symbol, Relation, RelationKind } from './ui-graph-types.js';
import { instance as vizInstance } from '@viz-js/viz';
import { applyTransform } from './ui-svg-transform.js';
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
    const osIsWin = process.platform==='win32';
    const normalize = (p:string)=> {
      let n = p.replace(/\\/g,'/');
      if (osIsWin && /^\/[A-Za-z]:\//.test(n)) n = n.slice(1); // unify /C:/path -> C:/path
      return n;
    };
    const withLeadingSlash = (p:string)=> (osIsWin && /^[A-Za-z]:\//.test(p) ? '/' + p : p);
    const caseKey = (p:string)=> osIsWin? p.toLowerCase():p;
    const idByCase = new Map<string, number>();
    for (const [p,id] of idBy) {
      const n = normalize(p);
      idByCase.set(caseKey(n), id);
      const alt = withLeadingSlash(n); if (alt!==n) idByCase.set(caseKey(alt), id);
      // Windows uppercase drive variant
      if (osIsWin && /^[A-Za-z]:\//.test(n)) {
        const up = n[0].toUpperCase() + n.slice(1);
        idByCase.set(caseKey(up), id);
        const upAlt = withLeadingSlash(up); if (upAlt!==up) idByCase.set(caseKey(upAlt), id);
      }
    }
    const flatByFile = new Map<number, Symbol[]>();
    for (const f of fileObjs){ const arr:Symbol[]=[]; for (const s of iterateSymbols(f.symbols)) if (isCallLike(s.kind)) arr.push(s); flatByFile.set(f.id, arr); }
    function findSymbol(fileId:number, pos:{line:number;character:number}): Symbol|undefined {
      return flatByFile.get(fileId)?.find(s=> s.range.start.line===pos.line && s.range.start.character===pos.character);
    }
    const visited = new Set<string>();
    const dedup = new Set<string>();
    const REL_CAP = Number(process.env.CRV_RELATION_CAP||8000);
    // Preload file texts once for position probing
    const fileTextCache = new Map<number,string>();
    async function getFileText(f:File){
      if (!fileTextCache.has(f.id)) {
        try { fileTextCache.set(f.id, await import('node:fs/promises').then(m=> m.readFile(f.path,'utf8'))); } catch { fileTextCache.set(f.id,''); }
      }
      return fileTextCache.get(f.id)!;
    }
    async function probePrepare(file:File, sym:Symbol){
      // Try original start, lines above (already done), and columns inside definition line to hit identifier token (Python sometimes needs inside name)
      let items = await client.prepareCallHierarchy(file.path, sym.range.start) || [];
      if (items.length) return items;
      // Columns inside line
      const text = await getFileText(file);
      const lineText = text.split(/\r?\n/)[sym.range.start.line]||'';
      for (let c = sym.range.start.character+1; c< Math.min(lineText.length, sym.range.start.character+40); c++){
        if (/\w/.test(lineText[c])) {
          items = await client.prepareCallHierarchy(file.path, { line:sym.range.start.line, character:c }) || [];
          if (items.length) return items;
        }
      }
      // Lines above fallback (already attempted in previous version); also try line below start in case symbol range points to decorators
      for (let delta of [1,2,3]){
        const alt = { line: Math.max(0, sym.range.start.line - delta), character: sym.range.start.character };
        items = await client.prepareCallHierarchy(file.path, alt) || [];
        if (items.length) return items;
      }
      for (let delta of [1,2]){
        const alt = { line: sym.range.start.line + delta, character: sym.range.start.character };
        items = await client.prepareCallHierarchy(file.path, alt) || [];
        if (items.length) return items;
      }
      return items; // empty
    }
    async function traverseFunc(fileId:number, sym:Symbol, depth:number){
      if (opts.maxDepth!=null && opts.maxDepth>=0 && depth>opts.maxDepth) return;
      const file = fileObjs.find(f=> f.id===fileId); if(!file) return;
      const key = `${fileId}:${sym.range.start.line}_${sym.range.start.character}`;
      if (visited.has(key)) return; visited.add(key);
      let items = await probePrepare(file, sym);
      for (const item of items){
  const incoming = await client.incomingCalls(item) || [];
        for (const call of incoming){
          const ep = call.from; if (!ep?.uri || !ep.selectionRange?.start) continue;
          let srcFileId: number | undefined;
          try {
            let uriStr: string;
            if (typeof ep.uri === 'string') uriStr = ep.uri; else if (ep.uri?.path) uriStr = ep.uri.path; else uriStr = String(ep.uri);
            if (/^file:\/\//i.test(uriStr)) {
              const parsed = URI.parse(uriStr);
              const fsPath = parsed.fsPath; // native path
              const norm = normalize(fsPath);
              for (const v of [norm, withLeadingSlash(norm)]) { const id = idByCase.get(caseKey(v)); if (id!=null){ srcFileId = id; break; } }
            } else {
              let raw = uriStr;
              try { raw = decodeURI(uriStr); } catch {/* ignore */}
              raw = raw.replace(/^file:\/+/, '');
              if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
              const norm = normalize(raw);
              for (const v of [norm, withLeadingSlash(norm)]) { const id = idByCase.get(caseKey(v)); if (id!=null){ srcFileId = id; break; } }
            }
          } catch {/* ignore */}
          if (srcFileId==null) {
            if ((process.env.CRV_DEBUG||'').includes('calls')) {
              try { console.error('[calls] unmatched incoming uri', JSON.stringify(ep.uri)); } catch {}
            }
            continue;
          }
          const sel = ep.selectionRange.start;
          let fromSym = findSymbol(srcFileId, sel);
          if (!fromSym){
            const synth: Symbol = { name: '(anon)', kind:12, range:{ start:{...sel}, end:{...sel} }, children:[] } as any;
            const pf = fileObjs.find(f=> f.id===srcFileId); if (pf){ pf.symbols.push(synth); flatByFile.get(srcFileId)?.push(synth); }
            fromSym = synth;
          }
          const edgeKey = `${srcFileId}:${fromSym.range.start.line}_${fromSym.range.start.character}->${fileId}:${sym.range.start.line}_${sym.range.start.character}`;
          if (!dedup.has(edgeKey)){
            dedup.add(edgeKey);
            relations.push({ from:{ fileId:srcFileId, line:fromSym.range.start.line, character:fromSym.range.start.character }, to:{ fileId, line:sym.range.start.line, character:sym.range.start.character }, kind:RelationKind.Call, _depth:depth });
            if (depth>maxDepthSeen) maxDepthSeen = depth;
          }
          await traverseFunc(srcFileId, fromSym, depth+1);
          if (relations.length >= REL_CAP) return;
        }
        // Supplement with outgoing calls if we still have only intra-file edges for this symbol (attempt to capture cross-file)
        if (relations.filter(r=> r.to.fileId!==r.from.fileId).length===0) {
          try {
            const outgoing = await client.outgoingCalls(item) || [];
            for (const oc of outgoing){
              const ep = oc.to; if (!ep?.uri || !ep.selectionRange?.start) continue;
              let dstFileId: number | undefined;
              try {
                let uriStr: string;
                if (typeof ep.uri === 'string') uriStr = ep.uri; else if (ep.uri?.path) uriStr = ep.uri.path; else uriStr = String(ep.uri);
                if (/^file:\/\//i.test(uriStr)) {
                  const parsed = URI.parse(uriStr);
                  const fsPath = parsed.fsPath; const norm = normalize(fsPath);
                  for (const v of [norm, withLeadingSlash(norm), norm[0]?.toUpperCase()+norm.slice(1)]) { const id = idByCase.get(caseKey(v)); if (id!=null){ dstFileId = id; break; } }
                } else {
                  let raw = uriStr; try { raw = decodeURI(uriStr); } catch {}
                  raw = raw.replace(/^file:\/+/, ''); if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
                  const norm = normalize(raw);
                  for (const v of [norm, withLeadingSlash(norm), norm[0]?.toUpperCase()+norm.slice(1)]) { const id = idByCase.get(caseKey(v)); if (id!=null){ dstFileId = id; break; } }
                }
              } catch {}
              if (dstFileId==null) continue;
              const sel = ep.selectionRange.start;
              const fromKey = `${fileId}:${sym.range.start.line}_${sym.range.start.character}`;
              const edgeKey = `${fromKey}->${dstFileId}:${sel.line}_${sel.character}`;
              if (!dedup.has(edgeKey)) {
                dedup.add(edgeKey);
                relations.push({ from:{ fileId, line:sym.range.start.line, character:sym.range.start.character }, to:{ fileId:dstFileId, line:sel.line, character:sel.character }, kind:RelationKind.Call, _depth:depth });
              }
            }
          } catch {/* ignore */}
        }
      }
    }
    for (const f of fileObjs){
      for (const s of iterateSymbols(f.symbols)) if (isCallLike(s.kind)) await traverseFunc(f.id, s, 0);
    }
    if (!process.env.CRV_QUIET) {
      const cross = relations.filter(r=> r.from.fileId!==r.to.fileId).length;
      console.error(`[sym] traversal relations=${relations.length} crossFile=${cross}`);
    }
  }
  // Naive Python fallback (augment even if we already have some relations) to approximate cross-file calls when LSP omits them
  if (!opts.skipCalls && fileObjs.some(f=> /\.py$/i.test(f.path))) {
      try {
        const pyFiles = fileObjs.filter(f=> /\.py$/i.test(f.path));
        const fs = await import('node:fs/promises');
        // Map function name -> array of symbols (could be duplicates per file / scope)
        interface FuncInfo { file:File; sym:Symbol; start:number; end:number; }
        const funcs: FuncInfo[] = [];
        for (const f of pyFiles){
          const text = await fs.readFile(f.path,'utf8').catch(()=> '');
          const lines = text.split(/\r?\n/);
          // determine end line by next symbol start
          const funcSyms = [...iterateSymbols(f.symbols)].filter(s=> isCallLike(s.kind));
          funcSyms.sort((a,b)=> a.range.start.line - b.range.start.line);
          for (let i=0;i<funcSyms.length;i++){
            const s = funcSyms[i];
            const start = s.range.start.line;
            const end = i+1<funcSyms.length ? funcSyms[i+1].range.start.line-1 : lines.length-1;
            funcs.push({ file:f, sym:s, start, end });
          }
        }
        const byName = new Map<string, FuncInfo[]>();
        for (const fi of funcs){
          const key = fi.sym.name;
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key)!.push(fi);
        }
        // Simple regex per function body to find calls to known names
        for (const fi of funcs){
          const text = await fs.readFile(fi.file.path,'utf8').catch(()=> '');
          const lines = text.split(/\r?\n/).slice(fi.start, fi.end+1);
          const body = lines.join('\n');
          for (const [name, targets] of byName){
            if (name===fi.sym.name) continue; // skip self
            const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
            if (callRe.test(body)){
              for (const tgt of targets){
                relations.push({
                  from:{ fileId:fi.file.id, line:fi.sym.range.start.line, character:fi.sym.range.start.character },
                  to:{ fileId:tgt.file.id, line:tgt.sym.range.start.line, character:tgt.sym.range.start.character },
                  kind: RelationKind.Call
                });
              }
            }
          }
        }
  if (!process.env.CRV_QUIET) console.error(`[sym] python-fallback augment totalRelations=${relations.length}`);
      } catch (e){ if ((process.env.CRV_DEBUG||'').includes('sym')) console.error('[sym] python-fallback error', e); }
    }
  // Optionally trim the deepest recorded depth (drop relations only at deepest level)
  let finalRelations: Relation[] = relations as Relation[];
  if (opts.trimLastDepth && maxDepthSeen>0) {
    finalRelations = relations.filter(r=> (r as any)._depth !== maxDepthSeen);
    if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] trimLastDepth applied: maxDepthSeen=${maxDepthSeen} kept=${finalRelations.length}/${relations.length}`);
  }
  // Build flattened symbol lists per file for tolerant lookup (exact start OR containment)
  interface FlatSym { sym:Symbol; startLine:number; startChar:number; endLine:number; endChar:number; }
  const flatByFile = new Map<number, FlatSym[]>();
  for (const f of fileObjs) {
    const arr: FlatSym[] = [];
    for (const s of iterateSymbols(f.symbols)) {
      const rs = s.range.start; const re = (s.range.end||s.range.start);
      arr.push({ sym:s, startLine:rs.line, startChar:rs.character, endLine:re.line, endChar:re.character });
    }
    flatByFile.set(f.id, arr);
  }
  function isBefore(aL:number,aC:number,bL:number,bC:number){ return aL<bL || (aL===bL && aC<=bC); }
  function contains(fs:FlatSym, line:number, ch:number){
    // Inclusive start, inclusive end (best-effort); Python defs usually have start char=0.
    if (!isBefore(fs.startLine, fs.startChar, line, ch)) return false;
    if (!isBefore(line, ch, fs.endLine, fs.endChar)) return false;
    return true;
  }
  function resolveFunc(fileId:number, line:number, ch:number): Symbol|undefined {
    const list = flatByFile.get(fileId); if (!list) return undefined;
    // 1. Exact start match first
    let exact = list.find(l=> l.startLine===line && l.startChar===ch && isCallLike(l.sym.kind));
    if (exact) return exact.sym;
    // 2. Containment: smallest containing call-like symbol
    let best: FlatSym|undefined;
    for (const fs of list) {
      if (!isCallLike(fs.sym.kind)) continue;
      if (contains(fs,line,ch)) {
        if (!best) best = fs; else {
          // Prefer tighter (range shorter)
            const bestSpan = (best.endLine-best.startLine)*10000 + (best.endChar-best.startChar);
            const curSpan = (fs.endLine-fs.startLine)*10000 + (fs.endChar-fs.startChar);
            if (curSpan < bestSpan) best = fs;
        }
      }
    }
    return best?.sym;
  }
  const kept: Relation[] = [];
  for (const r of finalRelations) {
    const fromSym = resolveFunc(r.from.fileId, r.from.line, r.from.character);
    const toSym   = resolveFunc(r.to.fileId, r.to.line, r.to.character);
    if (fromSym && toSym) kept.push(r);
  }
  if ((process.env.CRV_DEBUG||'').includes('sym')) {
    const cross = kept.filter(r=> r.from.fileId!==r.to.fileId).length;
    console.error(`[sym] filtered relations kept=${kept.length} crossFile=${cross}`);
  }
  return { files: fileObjs, relations: kept };
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
  // Restrict to function(12), method(6), constructor(9) only.
  return kind===12||kind===6||kind===9;
}

// 2. Convert Graph to DOT using same hierarchy helpers as file-level path logic
type GraphNode = { id:string; dir:string; labelHtml:string; };
type EdgeSpec = { tail:string; head:string; id:string; tailport?:string; headport?:string; class?:string; };

function symbolToCellDepth(fileId:number, s:Symbol, depth:number, maxDepth:number, collapse:boolean): string|undefined {
  if (depth>maxDepth) return undefined;
  const port = `${s.range.start.line}_${s.range.start.character}`;
  const text = escapeHtml(s.name);
  const icon = '';
  if (!s.children.length || depth===maxDepth) {
    return `<TR><TD PORT="${port}" ID="${fileId}:${port}" HREF="${s.kind}" BGCOLOR="${collapse? 'lightblue':'blue'}">${text}</TD></TR>`;
  }
  const child = s.children.map(c=> symbolToCellDepth(fileId,c,depth+1,maxDepth,collapse)).filter(Boolean).join('\n');
  return `
    <TR><TD CELLPADDING="0">
    <TABLE ID="${fileId}:${port}" HREF="${s.kind}" BORDER="0" CELLSPACING="8" CELLPADDING="4" CELLBORDER="0" BGCOLOR="green">
    <TR><TD PORT="${port}">${text}</TD></TR>
    ${child}
    </TABLE>
    </TD></TR>
  `;
}

function collectEdges(rel:Relation[], collapse:boolean, depthByPort:Set<string>, maxDepth:number, parentPortBy:Map<string,string|undefined>): EdgeSpec[] {
  // Filter out edges whose ports exceed maxDepth (symbolDepth) so we don't reference missing table cells
  function portKey(fileId:number,line:number,char:number){ return `${fileId}:${line}_${char}`; }
  const filtered: Relation[] = rel.filter(r=> depthByPort.has(portKey(r.from.fileId,r.from.line,r.from.character)) && depthByPort.has(portKey(r.to.fileId,r.to.line,r.to.character)));
  if (!collapse) return filtered.map(r=> ({ tail:`${r.from.fileId}`, head:`${r.to.fileId}`, id:`${r.from.fileId}:${r.from.line}_${r.from.character}-${r.to.fileId}:${r.to.line}_${r.to.character}`, tailport:`${r.from.line}_${r.from.character}`, headport:`${r.to.line}_${r.to.character}`, class: r.kind===RelationKind.Impl? 'impl': '' }));
  const map = new Map<string,EdgeSpec>();
  for (const r of filtered){
    const tail = r.from.fileId.toString();
    const head = r.to.fileId.toString();
    const cls = r.kind===RelationKind.Impl? 'impl': '';
    const id = `${tail}:${cls}-${head}:`;
    if (!map.has(id)) map.set(id,{ tail, head, id, class:cls });
  }
  return Array.from(map.values());
}

export function symbolGraphToDot(graph:Graph, _root:string, collapse:boolean, symbolDepth:number = Infinity): string {
  const baseNodes = convertToHierarchy(graph as any) as FileHierNode[];
  const fileById = new Map(graph.files.map(f=> [f.id.toString(), f] as const));
  const depthByPort = new Set<string>();
  const parentPortBy = new Map<string,string|undefined>();
  function visitSym(fileId:number, s:Symbol, depth:number, parentFull?:string){
    const full = `${fileId}:${s.range.start.line}_${s.range.start.character}`;
    parentPortBy.set(full, parentFull);
    if (depth <= symbolDepth) depthByPort.add(full);
    if (s.children.length) for (const c of s.children) visitSym(fileId,c,depth+1,full);
  }
  for (const f of graph.files) for (const s of f.symbols) visitSym(f.id,s,1,undefined);
  const nodes: GraphNode[] = baseNodes.map(n=> {
    const f = fileById.get(n.id)!;
    if (!f.symbols.length || symbolDepth<=0) return { id:n.id, dir:n.dir, labelHtml:n.labelHtml };
  const headerMatch = /<TABLE[^>]*>(<TR><TD HREF=[^]*?<\/TR>)/.exec(n.labelHtml);
  // Use raw file path (no leading slash) so click -> open resolves correctly on Windows
  const rawPath = f.path.replace(/\\/g,'/');
  const headerRow = headerMatch ? headerMatch[1] : `<TR><TD HREF="${rawPath}" DATA-FULLPATH="${rawPath}" WIDTH="230" BORDER="0" CELLPADDING="6">${escapeHtml(f.path.split(/[/\\]/).pop()||'')}</TD></TR>`;
    const symRows = f.symbols.map(s=> symbolToCellDepth(f.id,s,1,symbolDepth, collapse)).filter(Boolean).join('\n');
    const rebuilt = `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4">\n${headerRow}\n${symRows}\n<TR><TD CELLSPACING="0" HEIGHT="1" WIDTH="1" FIXEDSIZE="TRUE" STYLE="invis"></TD></TR>\n</TABLE>`;
    return { id:n.id, dir:n.dir, labelHtml:rebuilt };
  });
  const sub = buildSubgraphTree(nodes as unknown as FileHierNode[], '');
  const edges = collectEdges(graph.relations, collapse, depthByPort, symbolDepth, parentPortBy);
  const out:string[] = [];
  out.push('digraph G {');
  const cfg = getLayoutConfig();
  out.push(`rankdir=${cfg.rankdir||'LR'};`);
  out.push('ranksep=2.0;');
  out.push('fontsize=16; fontname="Arial";');
  out.push('node [fontsize=16 fontname="Arial" shape=plaintext style=filled];');
  out.push('edge [arrowsize=1.5 label=" "];');
  out.push('splines=true;');
  if (sub) emitSubgraphDOT(sub, out, { v:0 }); else nodes.forEach(n=> out.push(`${n.id} [id="${n.id}" label=<${n.labelHtml}> shape=plaintext style=filled]`));
  const isTB = (cfg.rankdir||'LR') === 'TB';
  for (const e of edges){
    // Ensure edge id matches webview pattern: fromCell-toCell when ports present
    let edgeId = e.id;
    if (e.tailport && e.headport) edgeId = `${e.tail}:${e.tailport}-${e.head}:${e.headport}`;
    const attrs = [`id="${edgeId}"`];
    if (e.class) attrs.push(`class="${e.class}"`);
    const sameNode = e.tail === e.head && e.tailport && e.headport && (!e.class || e.class!=='impl');
    if (e.tailport || e.headport) {
      if (isTB) {
        if (sameNode) {
          if (e.tailport) attrs.push(`tailport="${e.tailport}:e"`);
          if (e.headport) attrs.push(`headport="${e.headport}:e"`);
          attrs.push('constraint=false');
          attrs.push('minlen=1');
          if (!e.class) attrs.push('class="intra"');
        } else {
          if (e.tailport) attrs.push(`tailport="${e.tailport}:e"`);
          if (e.headport) attrs.push(`headport="${e.headport}:w"`);
        }
      } else {
        if (e.tailport) attrs.push(`tailport="${e.tailport}"`);
        if (e.headport) attrs.push(`headport="${e.headport}"`);
      }
    }
    out.push(`${e.tail} -> ${e.head} [${attrs.join(' ')} label=" "];`);
  }
  out.push('}');
  return out.join('\n');
}

// Backwards-compatible wrapper expected by cli.ts
export async function renderSymbolGraph(graph:Graph, root:string, collapse:boolean, symbolDepth:number){
  const dot = symbolGraphToDot(graph, root, collapse, symbolDepth);
  // Ensure DOMParser available or fallback to renderString
  if (!(globalThis as any).DOMParser) {
    try {
      const { JSDOM } = require('jsdom');
      const { window } = new JSDOM('<!doctype html><html><body></body></html>');
      (globalThis as any).window = window;
      (globalThis as any).document = window.document;
      (globalThis as any).DOMParser = window.DOMParser;
    } catch { /* ignore */ }
  }
  const viz = await vizInstance();
  try {
    const svgEl = viz.renderSVGElement(dot) as any;
    // Need real DOM for transformation
    if (!(globalThis as any).document?.createElementNS) {
      try {
        const { JSDOM } = require('jsdom');
        const { window } = new JSDOM('<!doctype html><html><body></body></html>');
        (globalThis as any).window = window;
        (globalThis as any).document = window.document;
      } catch {/* ignore */}
    }
    try { applyTransform(svgEl, null); } catch {/* ignore transform errors */}
    return { outerHTML: svgEl.outerHTML || String(svgEl) } as any;
  } catch {
    const svgText = await (viz as any).renderString(dot, { format:'svg', engine:'dot' });
    return { outerHTML: svgText } as any;
  }
}
