#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPyright, launchTsServer } from "./lsp-manager.js";
import { scanTs } from "./lang-ts.js";
import { scanPy } from "./lang-py.js";
import { buildStaticPyGraph } from './static-py.js';
import { mergeGraphs, toDot } from "./graph.js";
import { dotToHtml } from "./html.js";
import { emitCrabvizExportHtmlFromDot, emitCrabvizSvgFromDot, emitFileLevelInteractiveHtml } from "./export-html.js";
import { buildSymbolGraph, renderSymbolGraph } from './ui-symbol-graph.js';
import { setLayoutConfig } from './ui-file-graph.js';
import { generateUiStyleSvg } from './ui-file-graph.js';
import he from 'he';

type Args = {
  roots: string[];
  out: string;
  simplified: boolean;
  renderer: "export" | "viz";   // export = extension-like, viz = minimal
  format: "html" | "svg";       // only used with renderer=export
  uiFile: boolean;                // new: use file-level interactive pipeline
  maxDepth?: number;              // (deprecated) original recursion depth limit (0 previously disabled calls)
  callDepth?: number;             // new: external call hierarchy depth (0=file-level only, 1=direct calls, N>=2 deeper)
  impl?: boolean;                 // include implementation edges
  trimLastDepth?: boolean;        // drop deepest depth relations (one level before leaf)
  quiet?: boolean;                // suppress log output
  symbolDepth?: number;           // limit symbol nesting depth in UI export
  rankdir?: string;               // layout direction (LR or TB)
  filesPerRow?: number;           // when rankdir=TB, group N files per rank row inside folder clusters
  rootGrid?: string;              // layout grid specification CxR (Phase L1 parsing)
  showInternalFileCalls?: boolean; // keep self-loop file-level call edges at symbol depth
  symbolLayout?: string;          // 'table' | 'split' (split = per-symbol nodes)
  pythonEngine?: string;          // 'auto' | 'lsp' | 'static'
  hideImports?: boolean;          // hide import edges
  dotOut?: string;                // write raw DOT
};

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .option("roots", { type: "array", demandOption: true })
    .option("out", { type: "string", demandOption: true })
    .option("simplified", { type: "boolean", default: false })
  // Deprecated: --max-depth (legacy: 0 meant *no* calls). Keep for backward compatibility.
  .option("max-depth", { type: "number", describe: "[DEPRECATED] Use --call-depth instead. Legacy: 0 = no call edges.", default: undefined })
  .option("call-depth", { type: "number", describe: "Call hierarchy depth: 0=file-level only (imports), 1=direct calls, N=multi-hop. (default: 1)", default: 1 })
  .option("impl", { type: "boolean", describe: "Include interface implementation edges", default: true })
  .option("trim-last-depth", { type: "boolean", describe: "Trim the deepest collected call depth (one level before leaves)", default: false })
  .option("quiet", { type: "boolean", describe: "Suppress log / debug output", default: false })
  .option("renderer", { type: "string", choices: ["export","viz"] as const, default: "export" })
    .option("format", { type: "string", choices: ["html","svg"] as const, default: "html" })
  .option("ui-file", { type: "boolean", default: false, describe: "Use file-level UI-style interactive export (no function symbols yet)" })
  .option("symbol-depth", { type: "number", describe: "Limit symbol nesting depth for --ui-file export. 0 = files only, 1 = files & functions, 2 = files, functions & arguments. (default: 1)", default: 1 })
  .option("rankdir", { type: "string", choices: ["LR","TB"], describe: "Graph layout direction (LR=left-right, TB=top-bottom)", default: "LR" })
  .option("files-per-row", { type: "number", describe: "When --rankdir=TB, pack up to N file nodes per horizontal row within a folder", default: 0 })
  .option("root-grid", { type: "string", describe: "Arrange roots in a grid CxR (Phase L1: parse only, horizontal placement upcoming)", default: undefined })
  .option("show-internal-file-calls", { type: "boolean", describe: "Show call edges within the same file (symbol-level export). For --symbol-layout table these are rendered as an in-node overlay (no giant self-loop arcs). Hidden by default to reduce clutter", default: false })
  .option("symbol-layout", { type: "string", choices:["table","split","cluster"], describe: "Symbol rendering layout: table (single file node), split (loose symbol nodes), cluster (stacked per-symbol nodes in file cluster)", default: "split" })
  .option("python-engine", { type: "string", choices: ["auto","lsp","static"], default: "auto", describe: "Python analysis engine: static (AST) or lsp (pyright). auto selects static." })
  .option("hide-imports", { type: "boolean", default: false, describe: "Hide import edges (show only call edges)" })
  .option("dot-out", { type: "string", describe: "Also write raw DOT graph to this file (debug)" })
    .help().argv) as unknown as Args;

  const roots = argv.roots.map(r => resolve(String(r)));

  // Silence logs if requested
  if (argv.quiet) {
    // Keep a minimal final success message via process.stdout.write; override console outputs.
  (console as any)._origLog = console.log;
  (console as any)._origError = console.error;
  console.log = (()=>{}) as any;
  console.error = (()=>{}) as any;
  }

  // Use common project root for LSP servers to ensure project-wide features (call hierarchy) work
  function commonRoot(paths:string[]):string { if(!paths.length) return process.cwd(); const segs = paths.map(p=> p.split(/\\|\//)); const minLen = Math.min(...segs.map(a=>a.length)); let i=0; for(; i<minLen; i++){ const part = segs[0][i]; if(!segs.every(a=> a[i]===part)) break; } return segs[0].slice(0,i).join('/') || process.cwd(); }
  const lspRoot = commonRoot(roots);
  const tsClient = await launchTsServer(lspRoot);
  // Python engine selection (Stage 2): default to static to avoid weak LSP call hierarchy.
  const pythonEngine = (argv.pythonEngine||'auto');
  const useStatic = pythonEngine === 'static' || pythonEngine === 'auto';
  const pyClient = useStatic ? null : await launchPyright(lspRoot);

  try {
    // Apply layout config early (Phase L1: parse --root-grid CxR and pass through)
    let rootGridCfg: undefined | { cols:number; rows:number; raw:string } = undefined;
    if (argv.rootGrid) {
      const m = String(argv.rootGrid).trim().toLowerCase().match(/^(\d+)x(\d+)$/);
      if (m) {
        const cols = parseInt(m[1],10); const rows = parseInt(m[2],10);
        if (cols>0 && rows>0) rootGridCfg = { cols, rows, raw: argv.rootGrid };
      }
    }
    // Adaptive symbol layout default:
    // If user did NOT pass --symbol-layout explicitly, choose:
    //   rankdir=TB -> table (better stacking)
    //   rankdir=LR -> split  (better edge clarity)
    const userProvidedSymbolLayout = (process.argv.some(a=> a.startsWith('--symbol-layout')));
    const rankdirEff = (argv.rankdir==='TB'?'TB':'LR') as any;
    let effSymbolLayout: 'table' | 'split' | 'cluster';
    if (userProvidedSymbolLayout) {
      const sl = (argv as any).symbolLayout;
      effSymbolLayout = (sl === 'table' || sl === 'cluster') ? sl : 'split';
    } else {
      effSymbolLayout = rankdirEff === 'TB' ? 'table' : 'split';
    }
  const layoutForConfig = effSymbolLayout; // preserve cluster so symbol graph can detect it
    setLayoutConfig({
      rankdir: rankdirEff,
      filesPerRow: argv.filesPerRow && argv.filesPerRow>0 ? argv.filesPerRow : 0,
      rootGrid: rootGridCfg,
      rootPaths: roots,
      symbolLayout: layoutForConfig as any
    });
    const tsPart = await scanTs(roots, tsClient);
  const pyPart = await scanPy(roots, pyClient as any, { engine: useStatic? 'static':'lsp' });
  const gd     = mergeGraphs([tsPart, pyPart]);
  const staticPyGraph = (useStatic && pyPart.staticResult?.rawJson) ? buildStaticPyGraph(pyPart.staticResult.rawJson, pyPart.staticResult.moduleMap, { includeInternal: argv.showInternalFileCalls }) : null;

    // Determine effective call depth semantics
    // Priority: explicit --call-depth > legacy --max-depth > default (1)
    const legacyMaxDepth = argv.maxDepth;
    const callDepth = (typeof argv.callDepth === 'number' && !Number.isNaN(argv.callDepth))
      ? argv.callDepth!
      : (typeof legacyMaxDepth === 'number' ? legacyMaxDepth : 1);
    if (legacyMaxDepth !== undefined && argv.callDepth === undefined && !argv.quiet) {
      console.error('[crabviz] --max-depth is deprecated; use --call-depth. Interpreting value as call-depth.');
    }

    if (argv.uiFile && argv.renderer === 'export' && argv.format === 'html') {
        const symbolDepthFlag = (argv.symbolDepth ?? -1);
        // Determine effective depth: if -1 and simplified -> 0 (files only), if -1 and detailed -> unlimited
        const effectiveSymbolDepthSimplified = symbolDepthFlag >= 0 ? symbolDepthFlag : 0;
        const effectiveSymbolDepthDetailed   = symbolDepthFlag >= 0 ? symbolDepthFlag : Infinity;
      const fileIds = gd.nodes.map(n => n.id);
      if (!fileIds.length) { console.error('No files discovered for ui export.'); process.exit(1); }
      if (argv.simplified) {
        console.error('Building simplified (collapsed) graph with call relations (multi-language)...');
        // Partition files by extension for multi-language LSP usage
        const pyFiles = fileIds.filter(f=> /\.py$/i.test(f));
        const tsFiles = fileIds.filter(f=> !/\.py$/i.test(f));
        const subGraphs: any[] = [];
        // Respect --call-depth: internal maxDepth collects depths 0..callDepth-1. callDepth=0 => no call edges.
        const internalMaxDepth = callDepth <= 0 ? 0 : callDepth; // mirror detailed path semantics
        const skipCalls = callDepth === 0;
        if (tsFiles.length) subGraphs.push(await buildSymbolGraph(tsFiles, tsClient, { collapse:false, maxDepth: internalMaxDepth, includeImpl:false, trimLastDepth: argv.trimLastDepth, skipCalls }));
        if (pyFiles.length) {
          if (pyClient) {
            subGraphs.push(await buildSymbolGraph(pyFiles, pyClient, { collapse:false, maxDepth: internalMaxDepth, includeImpl:false, trimLastDepth: argv.trimLastDepth, skipCalls }));
          } else if (staticPyGraph) {
            // If static, we already have file-level collapsed call edges; strip them if callDepth=0
            const g = skipCalls ? { files: staticPyGraph.files, relations: [] } : staticPyGraph;
            subGraphs.push(g as any);
          }
        }
        // Reassign ids to keep them unique across merged graphs
        const symGraph = { files: [] as any[], relations: [] as any[] };
        let nextId = 0; const idRemap = new Map<string, number>();
        for (const sg of subGraphs) {
          for (const f of sg.files) { const newId = nextId++; idRemap.set(f.id+':'+f.path, newId); symGraph.files.push({ ...f, id:newId }); }
        }
        for (const sg of subGraphs) {
          for (const r of sg.relations) {
            const fromFile = sg.files.find((f:any)=> f.id===r.from.fileId);
            const toFile   = sg.files.find((f:any)=> f.id===r.to.fileId);
            if (!fromFile || !toFile) continue;
            const newFrom = idRemap.get(r.from.fileId+':'+fromFile.path);
            const newTo   = idRemap.get(r.to.fileId+':'+toFile.path);
            if (newFrom==null || newTo==null) continue;
            symGraph.relations.push({ ...r, from:{ ...r.from, fileId:newFrom }, to:{ ...r.to, fileId:newTo } });
          }
        }
        console.error('Simplified files (sample):', symGraph.files.slice(0,5).map(f=>f.path));
        const beforeRel = symGraph.relations.length;
        // Inject import edges (gd.edges) as additional file-level relations (dedup by from->to)
        if (gd.edges?.length) {
          const idIndex = new Map<string, number>(symGraph.files.map(f=> [f.path.replace(/\\/g,'/'), f.id] as const));
          const existing = new Set<string>(symGraph.relations.map(r=> `${r.from.fileId}->${r.to.fileId}`));
          let injected = 0;
          for (const e of gd.edges) {
            const a = idIndex.get(e.from.replace(/\\/g,'/'));
            const b = idIndex.get(e.to.replace(/\\/g,'/'));
            if (a==null || b==null || a===b) continue;
            const key = `${a}->${b}`;
            if (existing.has(key)) continue; // already have a relation via call graph
            existing.add(key);
            symGraph.relations.push({ from:{ fileId:a, line:0, character:0 }, to:{ fileId:b, line:0, character:0 }, kind:0 } as any);
            injected++;
          }
          console.error(`Call relations collected: ${beforeRel}; import edges injected: ${injected}; total now: ${symGraph.relations.length}`);
        } else {
          console.error(`Call relations collected: ${beforeRel}; no import edges available.`);
        }
        const rootDir = fileIds.length ? resolve(fileIds[0], '..') : process.cwd();
        // Render collapsed (collapse=true) so nodes show only file rows but edges are aggregated file-level.
  const svg = await renderSymbolGraph(symGraph, rootDir, true, effectiveSymbolDepthSimplified);
        const fsMod = await import('node:fs');
    function readAsset(rel:string, optional=false){
          const attempt = [
            resolve(rel),
            resolve('..','..',rel),
            resolve(process.cwd(),'..','..',rel)
          ];
      for (const a of attempt){ try { return fsMod.readFileSync(a,'utf8'); } catch {} }
      if (optional) return '';
      throw new Error('Asset not found: '+rel+' tried '+attempt.join(','));
        }
    const theme = readAsset('webview-ui/src/styles/graph-theme.css', true)+readAsset('webview-ui/src/styles/svg.css', true);
    const css = readAsset('webview-ui/src/assets/out/index.css', true);
    const js  = readAsset('webview-ui/src/assets/out/index.js', true);
    const runtimeInit = js.trim().length ? `${js}\ntry{const svgEl=document.querySelector('.callgraph');if(svgEl&& typeof CallGraph!=='undefined'){const g=new CallGraph(svgEl,null);g.setUpPanZoom();}}catch{}` : '';
    const html = `<!DOCTYPE html><html><head><meta charset=utf-8><title>${he.encode('Crabviz — Simplified')}</title><style>${theme}\n${css}</style></head><body>${svg.outerHTML}${ runtimeInit? `<script type=module>${runtimeInit}</script>`:''}</body></html>`;
        await import('node:fs').then(m=> { m.writeFileSync(resolve(argv.out), html, 'utf8'); });
  if (!argv.quiet) console.log(`Wrote ${resolve(argv.out)} (export/html ui simplified collapsed)`); else process.stdout.write(resolve(argv.out));
        return;
      } else {
        // Detailed symbol-level graph build via LSP (multi-language)
    console.error('Building symbol-level graph (multi-language)...');
  const pyFiles = fileIds.filter(f=> /\.py$/i.test(f));
  const tsFiles = fileIds.filter(f=> !/\.py$/i.test(f));
  const subGraphs: any[] = [];
  // Map callDepth to internal maxDepth: internal maxDepth = callDepth (depth levels collected are 0..callDepth-1)
  // Special case: callDepth 0 => skipCalls (file-level only)
  const internalMaxDepth = callDepth <= 0 ? 0 : callDepth; // pass through for readability
  const buildOptsBase = (skipCalls:boolean) => ({ collapse:false, maxDepth: internalMaxDepth, includeImpl: argv.impl!==false, trimLastDepth: argv.trimLastDepth, skipCalls });
  if (tsFiles.length) subGraphs.push(await buildSymbolGraph(tsFiles, tsClient, buildOptsBase(callDepth === 0)));
  if (pyFiles.length) {
    if (pyClient) subGraphs.push(await buildSymbolGraph(pyFiles, pyClient, buildOptsBase(callDepth === 0)));
    else if (staticPyGraph) {
      // Respect callDepth=0 by stripping call relations for static graph
      const g = callDepth === 0 ? { files: staticPyGraph.files, relations: [] } : staticPyGraph;
      subGraphs.push(g as any);
    }
  }
  const symGraph = { files: [] as any[], relations: [] as any[] };
  let nextId = 0; const idRemap = new Map<string, number>();
  for (const sg of subGraphs) {
    for (const f of sg.files) { const newId = nextId++; idRemap.set(f.id+':'+f.path, newId); symGraph.files.push({ ...f, id:newId }); }
  }
  for (const sg of subGraphs) {
    for (const r of sg.relations) {
      const fromFile = sg.files.find((f:any)=> f.id===r.from.fileId);
      const toFile   = sg.files.find((f:any)=> f.id===r.to.fileId);
      if (!fromFile || !toFile) continue;
      const newFrom = idRemap.get(r.from.fileId+':'+fromFile.path);
      const newTo   = idRemap.get(r.to.fileId+':'+toFile.path);
      if (newFrom==null || newTo==null) continue;
      symGraph.relations.push({ ...r, from:{ ...r.from, fileId:newFrom }, to:{ ...r.to, fileId:newTo } });
    }
  }
  // Reuse existing file-level import edges (gd.edges) so relationships (arrows) appear like UI.
  if (gd.edges?.length) {
    const idIndex = new Map(symGraph.files.map(f=> [f.path.replace(/\\/g,'/'), f.id] as const));
    const added = new Set<string>();
    for (const e of gd.edges) {
      const a = idIndex.get(e.from.replace(/\\/g,'/'));
      const b = idIndex.get(e.to.replace(/\\/g,'/'));
      if (a==null || b==null || a===b) continue;
      const key = a+'=>'+b;
      if (added.has(key)) continue;
      added.add(key);
      symGraph.relations.push({
        from:{ fileId:a, line:0, character:0 },
        to:{ fileId:b, line:0, character:0 },
        kind: 0 // RelationKind.Call equivalent
      } as any);
    }
  }
  // Drop same-file edges unless user explicitly wants them to reduce vertical stretching noise in TB layouts
  let effectiveLayout = 'table';
  try {
    const layoutCfgMod: any = await import('./ui-file-graph.js');
    if (layoutCfgMod && layoutCfgMod._layoutConfig && layoutCfgMod._layoutConfig.symbolLayout) {
      effectiveLayout = layoutCfgMod._layoutConfig.symbolLayout;
    }
  } catch { /* ignore */ }
  // Refresh effective layout from config (now includes 'cluster')
  try {
    const { getLayoutConfig } = await import('./ui-file-graph.js');
    const cfg = getLayoutConfig();
    effectiveLayout = (cfg.symbolLayout as any) || effectiveLayout;
  } catch {/* ignore */}
  let overlayInternalEdges: any[] | null = null;
  const wantOverlay = effectiveLayout === 'table' && argv.showInternalFileCalls; // always overlay in table layout when requested
  if (!argv.showInternalFileCalls) {
    // User did not request internal edges: drop them to reduce clutter
    symGraph.relations = symGraph.relations.filter(r=> r.from.fileId !== r.to.fileId);
  } else if (wantOverlay) {
    // Extract same-file edges so they are NOT rendered as Graphviz self-loops; keep for later overlay injection.
    overlayInternalEdges = symGraph.relations.filter(r=> r.from.fileId === r.to.fileId);
    symGraph.relations = symGraph.relations.filter(r=> r.from.fileId !== r.to.fileId);
    if (!argv.quiet) console.error('[crabviz] overlaying internal same-file edges inside table nodes (', overlayInternalEdges.length, 'edges )');
  }
  const rootDir = fileIds.length ? resolve(fileIds[0], '..') : process.cwd();
  // If callDepth=0 force symbol depth to 0 for pure file-level view (unless user explicitly set a positive symbolDepth)
  const effSymDepth = callDepth === 0 ? 0 : effectiveSymbolDepthDetailed;
  const svg = await renderSymbolGraph(symGraph, rootDir, false, effSymDepth);
        const fsMod = await import('node:fs');
        function readAsset(rel:string, optional=false){
          const attempt = [
            resolve(rel),
            resolve('..','..',rel),
            resolve(process.cwd(),'..','..',rel)
          ];
          for (const a of attempt){ try { return fsMod.readFileSync(a,'utf8'); } catch {} }
          if (optional) return '';
          throw new Error('Asset not found: '+rel+' tried '+attempt.join(','));
        }
        const theme = readAsset('webview-ui/src/styles/graph-theme.css', true)+readAsset('webview-ui/src/styles/svg.css', true);
        const css = readAsset('webview-ui/src/assets/out/index.css', true);
        const js  = readAsset('webview-ui/src/assets/out/index.js', true);
        const runtimeInit = js.trim().length ? `${js}\ntry{const svgEl=document.querySelector('.callgraph');if(svgEl&& typeof CallGraph!=='undefined'){const g=new CallGraph(svgEl,null);g.setUpPanZoom();}}catch{}` : '';
        let overlayScript = '';
        if (overlayInternalEdges && overlayInternalEdges.length) {
          const payload = JSON.stringify(overlayInternalEdges.map(e=> ({ f: e.from.fileId, fl:e.from.line, fc:e.from.character, t: e.to.fileId, tl:e.to.line, tc:e.to.character, k: e.kind })));
          // Build script without nested template literal interpolation that confuses TS parser
          let script = '';
          script += `<script type=module>\n`;
          script += `const data=${payload};\n`;
          script += `function draw(){\n`;
          script += ` const svg=document.querySelector('svg.callgraph'); if(!svg) return; const NS='http://www.w3.org/2000/svg';\n`;
          script += ` let grp=svg.querySelector('#internal-overlay'); if(!grp){ grp=document.createElementNS(NS,'g'); grp.id='internal-overlay'; grp.setAttribute('data-layer','internal'); grp.style.pointerEvents='none'; const g0=svg.getElementById('graph0'); if(g0){ g0.appendChild(grp); } }\n`;
          script += ` // ensure arrow marker\n`;
          script += ` let defs=svg.querySelector('defs'); if(!defs){ defs=document.createElementNS(NS,'defs'); svg.appendChild(defs);} if(!svg.querySelector('#internalArrow')){ const mk=document.createElementNS(NS,'marker'); mk.id='internalArrow'; mk.setAttribute('orient','auto'); mk.setAttribute('markerWidth','10'); mk.setAttribute('markerHeight','10'); mk.setAttribute('refX','8'); mk.setAttribute('refY','3'); const mp=document.createElementNS(NS,'path'); mp.setAttribute('d','M0,0 L0,6 L9,3 z'); mp.setAttribute('fill','#698b69'); mk.appendChild(mp); defs.appendChild(mk);}\n`;
          script += ` data.forEach(ed=>{\n`;
          script += `  const from=document.getElementById(ed.f+':'+ed.fl+'_'+ed.fc);\n`;
          script += `  const to=document.getElementById(ed.t+':'+ed.tl+'_'+ed.tc);\n`;
          script += `  if(!from||!to) return;\n`;
          script += `  const fb=(from).getBBox(); const tb=(to).getBBox();\n`;
          script += `  const x1=fb.x+fb.width; const y1=fb.y+fb.height/2; const x2=tb.x+tb.width; const y2=tb.y+tb.height/2;\n`;
          script += `  const fileNode = (from as any).closest('.node'); const nb = fileNode? fileNode.getBBox(): null;\n`;
          script += `  const downward = y2>=y1;\n`;
          script += `  let corridor; let leftMode=false;\n`;
          script += `  if(nb){ if(downward){ corridor = nb.x + nb.width - 6; } else { leftMode=true; corridor = nb.x + 6; } } else { corridor = Math.max(x1,x2)+8; }\n`;
          script += `  const path=document.createElementNS(NS,'path');\n`;
          script += `  let d;\n`;
          script += `  if(Math.abs(y2-y1)<14){ // short hop: small cubic to visually connect rows
            const cx = leftMode? corridor : corridor; d='M'+x1+','+y1+' C '+cx+','+y1+' '+cx+','+y2+' '+x2+','+y2; }
          else if(leftMode){ d='M'+x1+','+y1+' L '+(nb? nb.x+nb.width-4 : x1+4)+','+y1+' L '+corridor+','+y1+' L '+corridor+','+y2+' L '+(nb? nb.x+nb.width-4 : x2-4)+','+y2+' L '+x2+','+y2; }
          else { d='M'+x1+','+y1+' L '+corridor+','+y1+' L '+corridor+','+y2+' L '+x2+','+y2; }\n`;
          script += `  path.setAttribute('d', d);\n`;
          script += `  path.setAttribute('stroke','#698b69'); path.setAttribute('fill','none'); path.setAttribute('stroke-width','2'); path.setAttribute('marker-end','url(#internalArrow)'); path.setAttribute('data-internal','1');\n`;
          script += `  path.classList.add('edge','internal-overlay','internal-call'); grp.appendChild(path);\n`;
          script += ` });\n`;
          script += `}\n`;
          script += `if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', draw); else draw();\n`;
          script += `</script>`;
          overlayScript = script;
        }
        const html = `<!DOCTYPE html><html><head><meta charset=utf-8><title>${he.encode('Crabviz Detailed')}</title><style>${theme}\n${css}</style></head><body>${svg.outerHTML}${ runtimeInit? `<script type=module>${runtimeInit}</script>`:''}${overlayScript}</body></html>`;
        await import('node:fs').then(m=> { m.writeFileSync(resolve(argv.out), html, 'utf8'); });
  if (!argv.quiet) console.log(`Wrote ${resolve(argv.out)} (export/html ui detailed)`); else process.stdout.write(resolve(argv.out));
        return;
      }
    }

    // Optionally filter import edges
    const filteredGd = argv.hideImports ? { nodes: gd.nodes, edges: gd.edges.filter(e=> e.kind !== 'import' && e.kind !== 'dynamic-import') } : gd;
    const dot    = toDot(filteredGd, argv.simplified);
    if (argv.dotOut) {
      writeFileSync(resolve(String(argv.dotOut)), dot, 'utf8');
      if (!argv.quiet) console.error(`[crabviz] wrote DOT ${resolve(String(argv.dotOut))}`);
    }

    if (argv.renderer === "export") {
      if (argv.format === "svg") {
        await emitCrabvizSvgFromDot(argv.out, dot);
        console.log(`Wrote ${resolve(argv.out)} (export/svg)`);
      } else {
        await emitCrabvizExportHtmlFromDot(argv.out, dot, `Crabviz${argv.simplified ? " — Simplified" : ""}`);
        if (!argv.quiet) console.log(`Wrote ${resolve(argv.out)} (export/html)`); else process.stdout.write(resolve(argv.out));
      }
    } else {
      // minimal fallback
      const html = await dotToHtml(dot);
      writeFileSync(resolve(argv.out), html, "utf8");
      if (!argv.quiet) console.log(`Wrote ${resolve(argv.out)} (viz/minimal)`); else process.stdout.write(resolve(argv.out));
    }
  } finally {
  await Promise.allSettled([tsClient.dispose(), pyClient?.dispose?.()]);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
