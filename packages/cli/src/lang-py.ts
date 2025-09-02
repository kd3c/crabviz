import fg from 'fast-glob';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { LspClient } from './lsp-manager.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Edge, NodeInfo } from './types.js';

const importRe = /^\s*(?:from\s+([.\w]+)\s+import\s+[\w*,\s]+|import\s+([\w.]+))/gm;

interface ScanPyOpts { engine: 'static' | 'lsp'; }

export interface StaticAnalysisResult { rawJson?: string; moduleMap?: Record<string,string>; }

export async function scanPy(
  roots: string[],
  client: LspClient | null,
  opts: ScanPyOpts
): Promise<{ nodes: NodeInfo[]; edges: Edge[]; staticResult?: StaticAnalysisResult }> {
  const files = await fg(roots.map(r => `${r.replace(/\\/g,'/')}/**/*.py`), { dot:false });
  // Build module name -> path map for absolute imports (within provided roots)
  const moduleMap = new Map<string,string>();
  const norm = (p:string)=> p.replace(/\\/g,'/');
  const rootNorms = roots.map(norm);
  function addModuleMapping(filePath:string){
    const rpRoot = rootNorms.find(r => norm(filePath).startsWith(r));
    if (!rpRoot) return;
    let rel = norm(filePath).slice(rpRoot.length).replace(/^\//,'');
    if (rel.endsWith('__init__.py')) rel = rel.slice(0,-12); // drop __init__.py
    else if (rel.endsWith('.py')) rel = rel.slice(0,-3);
    if (!rel.length) return; // top-level package root
    const mod = rel.split('/').filter(Boolean).join('.');
    if (mod) moduleMap.set(mod, filePath);
  }
  for (const f of files) addModuleMapping(f);

  // Build reverse index for heuristic resolution (basename -> files)
  const byBase = new Map<string, string[]>() ;
  for (const f of files) {
    const base = f.substring(f.lastIndexOf('/')+1).replace(/\.py$/,'');
    const arr = byBase.get(base) || []; arr.push(f); byBase.set(base, arr);
  }

  function resolveAbsoluteModule(spec:string): string | null {
    // Try direct match; progressively trim last segment for packages
    if (moduleMap.has(spec)) return moduleMap.get(spec)!;
    // Try as package (append __init__.py) if path exists
    const pathCandidate = spec.replace(/\./g,'/');
    for (const r of rootNorms) {
      const full = norm(join(r, pathCandidate + '.py'));
      if (existsSync(full)) return full;
      const initFile = norm(join(r, pathCandidate, '__init__.py'));
      if (existsSync(initFile)) return initFile;
    }
    // Heuristic: last segment match
    const last = spec.split('.').pop()!;
    const cands = byBase.get(last);
    if (cands && cands.length === 1) return cands[0];
    return null;
  }

  function resolveRelativeModule(currentFile:string, spec:string): string | null {
    const m = spec.match(/^(\.+)(.*)$/);
    if (!m) return null;
    const dots = m[1].length; // number of leading dots
    const rest = m[2]; // may be empty or like pkg.sub
    let baseDir = dirname(currentFile).replace(/\\/g,'/');
    // In Python, one leading dot means current package (no ascend). Ascend dots-1 levels.
    for (let i=0;i<Math.max(0,dots-1);i++) {
      const idx = baseDir.lastIndexOf('/');
      if (idx === -1) break;
      baseDir = baseDir.slice(0, idx);
    }
    let relPath = baseDir;
    if (rest) relPath = relPath + '/' + rest.replace(/\./g,'/');
    // Try file.py then package/__init__.py
    const fileCandidate = relPath + '.py';
    if (existsSync(fileCandidate)) return fileCandidate;
    const initCandidate = relPath + '/__init__.py';
    if (existsSync(initCandidate)) return initCandidate;
    return null;
  }
  const nodes: NodeInfo[] = [];
  const edges: Edge[] = [];

  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    nodes.push({ id: f, lang: 'py' });
    if (client && opts.engine==='lsp') {
      await client.didOpen(f, 'python', text);
    }

    let m: RegExpExecArray | null;
  while ((m = importRe.exec(text))) {
      const spec = (m[1] || m[2])?.trim();
      if (!spec) continue;
      let target: string | null = null;
  if (spec.startsWith('.')) target = resolveRelativeModule(f, spec);
  else target = resolveAbsoluteModule(spec);
  if (!target) { if ((process.env.CRV_DEBUG||'').includes('py')) console.error(`[py] unresolved import ${spec} in ${f}`); continue; }
  if ((process.env.CRV_DEBUG||'').includes('py')) console.error(`[py] import ${spec} -> ${target}`);
      edges.push({ from: f, to: target, kind: 'import', lang: 'py' });
    }

  // If no edges resolved for this file and we want richer graph, attempt simple intra-package link by matching sibling imports
  // (skip if edges already found globally)
  }
  // Stage 2: if static engine, invoke external analyzer for potential future function-level integration (not yet merged into edges/nodes schema here).
  let staticResult: StaticAnalysisResult | undefined;
  if (opts.engine === 'static') {
    try {
      const repoRoot = resolve(roots[0]);
      // Attempt to locate py_callscan.py walking upward from repoRoot.
      const candidates: string[] = [];
      let cur = repoRoot;
      for (let i=0;i<5;i++) { // up to 5 levels
        candidates.push(resolve(cur, 'scripts', 'py_callscan.py'));
        const parent = resolve(cur, '..');
        if (parent === cur) break;
        cur = parent;
      }
      candidates.push(resolve(process.cwd(), 'scripts', 'py_callscan.py'));
      let scriptPath: string | null = null;
      for (const c of candidates) { if (existsSync(c)) { scriptPath = c; break; } }
      if (scriptPath) {
        const pyCmds = ['python','py'];
        let run;
        for (const cmd of pyCmds) {
          run = spawnSync(cmd, [scriptPath, '--root', repoRoot, '--max-file-size', '1000000'], { encoding: 'utf-8' });
          if (!run.error) break;
        }
    if (run && run.status === 0) {
          if ((process.env.CRV_DEBUG||'').includes('py')) {
            console.error(`[py-static] scanned: ${scriptPath} bytesOut=${run.stdout.length}`);
          }
          // (Deferred) Parse JSON and integrate call edges in later stage.
          try {
            const parsed = JSON.parse(run.stdout);
            const fCount = parsed.functions?.length ?? 0;
            const eCount = parsed.edges?.length ?? 0;
    console.error(`[py-static] summary functions=${fCount} edges=${eCount} unresolved=${parsed.unresolved_calls?.length||0}`);
  // Export module->file path map for later static graph reconstruction
  const mMap: Record<string,string> = {};
  for (const [mod,path] of moduleMap.entries()) mMap[mod]=path;
  staticResult = { rawJson: run.stdout, moduleMap: mMap };
          } catch (e:any) {
            console.error('[py-static] failed to parse analyzer JSON', e?.message||e);
          }
        } else if (run) {
          console.error(`[py-static] analyzer failed status=${run.status} err=${run.error||''}`);
        }
      } else {
        console.error('[py-static] py_callscan.py not found; skipping static analysis augmentation');
      }
    } catch (e:any) {
      console.error('[py-static] error invoking analyzer', e?.message||e);
    }
  }
  return { nodes, edges, staticResult };
}
