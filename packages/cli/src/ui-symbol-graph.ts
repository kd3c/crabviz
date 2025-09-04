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
    if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym] call relations=${callCount} impl relations=${relations.length-callCount} total=${relations.length}`);
  if ((process.env.CRV_DEBUG||'').includes('sym')) console.error(`[sym:stats] callable=${callableTotal} prepareTotal=${prepareTotal} prepareWithItems=${prepareWithItems} prepareEmpty=${prepareEmpty}`);
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
  out.push('splines=true;');
  if (sub) emitSubgraphDOT(sub, out, { v:0 }); else nodes.forEach(n=> out.push(`${n.id} [id="${n.id}" label=<${n.labelHtml}> shape=plaintext style=filled]`));
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
