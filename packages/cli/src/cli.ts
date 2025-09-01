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
};

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .option("roots", { type: "array", demandOption: true })
    .option("out", { type: "string", demandOption: true })
    .option("simplified", { type: "boolean", default: false })
  .option("max-depth", { type: "number", describe: "Max recursive call hierarchy depth (default unlimited)", default: 0 })
  .option("impl", { type: "boolean", describe: "Include interface implementation edges", default: true })
  .option("renderer", { type: "string", choices: ["export","viz"] as const, default: "export" })
    .option("format", { type: "string", choices: ["html","svg"] as const, default: "html" })
  .option("ui-file", { type: "boolean", default: false, describe: "Use file-level UI-style interactive export (no function symbols yet)" })
    .help().argv) as unknown as Args;

  const roots = argv.roots.map(r => resolve(String(r)));

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
      const fileIds = gd.nodes.map(n => n.id);
      if (!fileIds.length) { console.error('No files discovered for ui export.'); process.exit(1); }
      if (argv.simplified) {
        await emitFileLevelInteractiveHtml(
          argv.out,
          fileIds,
          gd.edges.map(e => ({ from: e.from, to: e.to })),
          true,
          `Crabviz — Simplified`
        );
        console.log(`Wrote ${resolve(argv.out)} (export/html ui-file simplified)`);
        return;
      } else {
        // Detailed symbol-level graph build via LSP (best-effort)
    console.error('Building symbol-level graph (may take a while)...');
  const symGraph = await buildSymbolGraph(fileIds, tsClient, { collapse:false, maxDepth: argv.maxDepth||0, includeImpl: argv.impl!==false });
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
  const svg = await renderSymbolGraph(symGraph, rootDir, false);
        const theme = await import('node:fs').then(m=> m.readFileSync(resolve('webview-ui/src/styles/graph-theme.css'),'utf8')+m.readFileSync(resolve('webview-ui/src/styles/svg.css'),'utf8'));
        const css = await import('node:fs').then(m=> m.readFileSync(resolve('webview-ui/src/assets/out/index.css'),'utf8'));
        const js  = await import('node:fs').then(m=> m.readFileSync(resolve('webview-ui/src/assets/out/index.js'),'utf8'));
        const html = `<!DOCTYPE html><html><head><meta charset=utf-8><title>${he.encode('Crabviz Detailed')}</title><style>${theme}\n${css}</style></head><body>${svg.outerHTML}<script type=module>${js}\nconst svgEl=document.querySelector('.callgraph');if(svgEl){const g=new CallGraph(svgEl,null);g.setUpPanZoom();}</script></body></html>`;
        await import('node:fs').then(m=> { m.writeFileSync(resolve(argv.out), html, 'utf8'); });
  console.log(`Wrote ${resolve(argv.out)} (export/html ui detailed)`);
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
        console.log(`Wrote ${resolve(argv.out)} (export/html)`);
      }
    } else {
      // minimal fallback
      const html = await dotToHtml(dot);
      writeFileSync(resolve(argv.out), html, "utf8");
      console.log(`Wrote ${resolve(argv.out)} (viz/minimal)`);
    }
  } finally {
    await Promise.allSettled([tsClient.dispose(), pyClient.dispose()]);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
