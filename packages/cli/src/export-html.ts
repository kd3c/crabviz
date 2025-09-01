// packages/cli/src/export-html.ts
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import he from "he";
// new UI-style file-level generator
import { generateUiStyleSvg } from './ui-file-graph.js';

/**
 * Render DOT to SVG using viz.js full renderer.
 */
async function dotToSvg(dot: string): Promise<string> {
  // dynamic ESM imports so Node (CJS/ESM) doesn’t choke
  const VizMod: any = await import("viz.js");
  const Full: any = await import("viz.js/full.render.js");
  const Viz = VizMod.default ?? VizMod;
  const viz = new Viz({ Module: Full.Module, render: Full.render });
  return viz.renderString(dot);
}

/**
 * Use the *export assets* shipped in webview-ui (same ones the extension uses for “Save as HTML”)
 * to produce a single-file HTML with your pre-rendered SVG.
 * No webview, no message bus, no server.
 */
export async function emitCrabvizExportHtmlFromDot(
  outFile: string,
  dot: string,
  title = "Crabviz Export"
): Promise<void> {
  // These files are produced/maintained by the export build:
  //    vite build -c webview-ui/vite-export.config.ts
  // (Your earlier build already emitted: webview-ui/src/assets/out/index.css|js)
  const cssPath = resolve("webview-ui/src/assets/out/index.css");
  const jsPath  = resolve("webview-ui/src/assets/out/index.js");

  const css = readFileSync(cssPath, "utf8");
  const js  = readFileSync(jsPath, "utf8");
  let svg = await dotToSvg(dot);

  // Ensure the root <svg> has the class expected by the interactive script.
  // Also strip any XML declaration that viz.js might prepend.
  svg = svg.replace(/<\?xml[^>]*>/i, "").trim();
  svg = svg.replace(/<svg(\s+)/i, '<svg class="callgraph" $1');
  if (!/class="[^"]*callgraph/.test(svg)) {
    // Fallback if previous regex failed due to formatting
    svg = svg.replace(/<svg([^>]*)>/i, '<svg class="callgraph"$1>');
  }

  const outPath = resolve(outFile);
  mkdirSync(dirname(outPath), { recursive: true });

  // Inline HTML template mirrors webview-ui/src/export/templates.ts (html()) variant.
  // We embed the library (ES module) code then instantiate CallGraph + enable pan/zoom.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${he.encode(title)}</title>
  <style>
    html, body { width:100%; height:100%; margin:0; padding:0; background: var(--background-color); }
    ${css}
  </style>
</head>
<body>
${svg}
<script type="module">
${js}
// Auto-initialize interactive graph (no focus cell in current CLI flow)
try {
  const svgEl = document.querySelector('.callgraph');
  if (svgEl) {
    const graph = new CallGraph(svgEl, null);
    graph.setUpPanZoom();
  }
} catch (e) { console.error('Crabviz init error', e); }
</script>
</body>
</html>`;

  writeFileSync(outPath, html, "utf8");
}

/**
 * New: file-level interactive export (no function symbol detail yet) reusing webview styles/JS.
 */
export async function emitFileLevelInteractiveHtml(outFile:string, files:string[], edges:{from:string; to:string}[], simplified:boolean, title='Crabviz'): Promise<void> {
  const cssPath = resolve('webview-ui/src/assets/out/index.css');
  const jsPath  = resolve('webview-ui/src/assets/out/index.js');
  const themeCss = readFileSync(resolve('webview-ui/src/styles/graph-theme.css'), 'utf8');
  const svgCss   = readFileSync(resolve('webview-ui/src/styles/svg.css'), 'utf8');
  const css = readFileSync(cssPath, 'utf8');
  const js  = readFileSync(jsPath, 'utf8');
  const rootDir = files.length ? dirname(files[0]) : process.cwd();
  const svgEl = await generateUiStyleSvg(files, edges, rootDir, simplified);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${he.encode(title)}</title><style>${themeCss}\n${svgCss}\nhtml,body{width:100%;height:100%;margin:0;padding:0;background:var(--background-color);} ${css}</style></head><body>${svgEl.outerHTML}<script type="module">${js}\nconst svg=document.querySelector('.callgraph');if(svg){const g=new CallGraph(svg,null);g.setUpPanZoom();}</script></body></html>`;
  mkdirSync(dirname(resolve(outFile)), { recursive:true });
  writeFileSync(resolve(outFile), html, 'utf8');
}

// (basename helper removed; not required for current implementation.)

/**
 * Optional: write a pure SVG file (same graph) if you also want the extension’s “Save as SVG” analogue.
 */
export async function emitCrabvizSvgFromDot(outFile: string, dot: string): Promise<void> {
  const svg = await dotToSvg(dot);
  writeFileSync(resolve(outFile), svg, "utf8");
}
