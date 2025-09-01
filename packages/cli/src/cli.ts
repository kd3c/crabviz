#!/usr/bin/env node
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPyright, launchTsServer } from "./lsp-manager.js";
import { scanTs } from "./lang-ts.js";
import { scanPy } from "./lang-py.js";
import { mergeGraphs, toDot } from "./graph.js";
import { dotToHtml } from "./html.js";
import { emitCrabvizExportHtmlFromDot, emitCrabvizSvgFromDot, emitFileLevelInteractiveHtml } from "./export-html.js";
import { buildSymbolGraph, renderSymbolGraph } from './ui-symbol-graph.js';
import { generateUiStyleSvg } from './ui-file-graph.js';
import he from 'he';

type Args = {
  roots: string[];
  out: string;
  simplified: boolean;
  renderer: "export" | "viz";   // export = extension-like, viz = minimal
  format: "html" | "svg";       // only used with renderer=export
  uiFile: boolean;                // new: use file-level interactive pipeline
  maxDepth?: number;              // call graph recursion depth limit
  impl?: boolean;                 // include implementation edges
  trimLastDepth?: boolean;        // drop deepest depth relations (one level before leaf)
  quiet?: boolean;                // suppress log output
  symbolDepth?: number;           // limit symbol nesting depth in UI export
};

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .option("roots", { type: "array", demandOption: true })
    .option("out", { type: "string", demandOption: true })
    .option("simplified", { type: "boolean", default: false })
  .option("max-depth", { type: "number", describe: "Max recursive call hierarchy depth (default unlimited)", default: 0 })
  .option("impl", { type: "boolean", describe: "Include interface implementation edges", default: true })
  .option("trim-last-depth", { type: "boolean", describe: "Trim the deepest collected call depth (one level before leaves)", default: false })
  .option("quiet", { type: "boolean", describe: "Suppress log / debug output", default: false })
  .option("renderer", { type: "string", choices: ["export","viz"] as const, default: "export" })
    .option("format", { type: "string", choices: ["html","svg"] as const, default: "html" })
  .option("ui-file", { type: "boolean", default: false, describe: "Use file-level UI-style interactive export (no function symbols yet)" })
  .option("symbol-depth", { type: "number", describe: "Limit symbol nesting depth for --ui-file export. 0 = no symbols (file rows only), 1 = top-level symbols, etc. (default: unlimited for detailed, 0 for --simplified)", default: -1 })
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
  const pyClient = await launchPyright(lspRoot);

  try {
    const tsPart = await scanTs(roots, tsClient);
    const pyPart = await scanPy(roots, pyClient);
    const gd     = mergeGraphs([tsPart, pyPart]);

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
  if (tsFiles.length) subGraphs.push(await buildSymbolGraph(tsFiles, tsClient, { collapse:false, maxDepth:0, includeImpl:false, trimLastDepth: argv.trimLastDepth, skipCalls:true }));
  if (pyFiles.length) subGraphs.push(await buildSymbolGraph(pyFiles, pyClient, { collapse:false, maxDepth:0, includeImpl:false, trimLastDepth: argv.trimLastDepth, skipCalls:true }));
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
  if (tsFiles.length) subGraphs.push(await buildSymbolGraph(tsFiles, tsClient, { collapse:false, maxDepth: argv.maxDepth||0, includeImpl: argv.impl!==false, trimLastDepth: argv.trimLastDepth }));
  if (pyFiles.length) subGraphs.push(await buildSymbolGraph(pyFiles, pyClient, { collapse:false, maxDepth: argv.maxDepth||0, includeImpl: argv.impl!==false, trimLastDepth: argv.trimLastDepth }));
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
  const rootDir = fileIds.length ? resolve(fileIds[0], '..') : process.cwd();
  const svg = await renderSymbolGraph(symGraph, rootDir, false, effectiveSymbolDepthDetailed);
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
        const html = `<!DOCTYPE html><html><head><meta charset=utf-8><title>${he.encode('Crabviz Detailed')}</title><style>${theme}\n${css}</style></head><body>${svg.outerHTML}${ runtimeInit? `<script type=module>${runtimeInit}</script>`:''}</body></html>`;
        await import('node:fs').then(m=> { m.writeFileSync(resolve(argv.out), html, 'utf8'); });
  if (!argv.quiet) console.log(`Wrote ${resolve(argv.out)} (export/html ui detailed)`); else process.stdout.write(resolve(argv.out));
        return;
      }
    }

    const dot    = toDot(gd, argv.simplified);

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
    await Promise.allSettled([tsClient.dispose(), pyClient.dispose()]);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
