import Viz from "viz.js";
import he from "he";

export async function dotToHtml(dot: string): Promise<string> {
  // Import the full renderer and treat it as any to avoid TS complaints
  const mod: any = await import("viz.js/full.render.js");
  const viz = new Viz({ Module: mod.Module, render: mod.render });
  const svg = await viz.renderString(dot);
  const title = "Crabviz (Headless)";
  return `<!doctype html>
<meta charset="utf-8">
<title>${he.encode(title)}</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:16px}svg{width:100%;height:auto}</style>
<h1>${he.encode(title)}</h1>
<div>${svg}</div>`;
}
