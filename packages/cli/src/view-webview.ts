// packages/cli/src/view-webview.ts
import { mkdirSync, writeFileSync, cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import he from "he";
import { GraphData } from "./types.js";

function findAssets(dir: string) {
  const files = readdirSync(dir);
  const css = files.find(f => f.endsWith(".css")) ?? "";
  const js  = files.find(f => f.endsWith(".js"))  ?? "";
  return { css, js };
}

function pickWebviewDir(): string {
  const extOut = resolve("editors/code/out/webview-ui");
  if (existsSync(extOut)) return extOut;
  const dist = resolve("webview-ui/dist");
  if (existsSync(dist)) return dist;
  throw new Error("No webview build found. Run `npm run build` in webview-ui.");
}

export function emitCrabvizWebviewHtml(
  outFile: string,
  data: GraphData,
  opts: { simplified: boolean }
) {
  const webviewDir = pickWebviewDir();
  const outDir = dirname(resolve(outFile));
  mkdirSync(outDir, { recursive: true });

  const targetUiDir = join(outDir, "crabviz-ui");
  if (!existsSync(targetUiDir)) cpSync(webviewDir, targetUiDir, { recursive: true });

  const { css, js } = findAssets(targetUiDir);
  if (!js) throw new Error(`Could not find webview JS in ${targetUiDir}`);

  const title = `Crabviz (Webview)${opts.simplified ? " — Simplified" : ""}`;
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");

  const boot = `
    window.acquireVsCodeApi = window.acquireVsCodeApi || (() => ({
      postMessage: () => {}, getState: () => ({}), setState: () => {}
    }));
    window.CRABVIZ_DATA = ${payload};
    window.CRABVIZ_OPTIONS = ${JSON.stringify({ simplified: opts.simplified })};
    window.addEventListener('DOMContentLoaded', () => {
      window.postMessage({ type: 'CRABVIZ_DATA', payload: window.CRABVIZ_DATA }, '*');
    });
  `;

  const html = `<!doctype html>
<meta charset="utf-8">
<title>${he.encode(title)}</title>
<link rel="stylesheet" href="./crabviz-ui/${css}">
<style>html,body{height:100%;margin:0;background:#0b1220;color:#e5edf5}</style>
<script>${boot}</script>
<div id="root"></div>
<script type="module" src="./crabviz-ui/${js}"></script>`;

  writeFileSync(outFile, html);
}
