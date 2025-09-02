import fg from 'fast-glob';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { LspClient } from './lsp-manager.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Edge, NodeInfo } from './types.js';

// Captures:
//  from pkg.sub import a, b  -> group1=pkg.sub group2="a, b"
//  import pkg.sub             -> group3=pkg.sub
const importRe = /^\s*(?:from\s+([.\w]+)\s+import\s+([\w*,\s]+)|import\s+([\w.]+))/gm;

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
    const fromMod = m[1];
    const importedList = m[2];
    const plainImport = m[3];
    if (plainImport) {
      const spec = plainImport.trim();
      let target: string | null = null;
      if (spec.startsWith('.')) target = resolveRelativeModule(f, spec);
      else target = resolveAbsoluteModule(spec);
      if (!target) { if ((process.env.CRV_DEBUG||'').includes('py')) console.error(`[py] unresolved import ${spec} in ${f}`); continue; }
      if ((process.env.CRV_DEBUG||'').includes('py')) console.error(`[py] import ${spec} -> ${target}`);
      edges.push({ from: f, to: target, kind: 'import', lang: 'py' });
      continue;
    }
    if (fromMod) {
      const baseSpec = fromMod.trim();
      const names = (importedList||'').split(',').map(s=> s.trim()).filter(Boolean);
      if (!names.length) {
        // treat like a plain module import
        let target: string | null = null;
        if (baseSpec.startsWith('.')) target = resolveRelativeModule(f, baseSpec);
        else target = resolveAbsoluteModule(baseSpec);
        if (target) edges.push({ from: f, to: target, kind: 'import', lang: 'py' });
        continue;
      }
      for (const name of names) {
        if (name === '*') continue; // skip star imports for now
        const fullSpec = baseSpec + '.' + name;
        let target: string | null = null;
        if (fullSpec.startsWith('.')) target = resolveRelativeModule(f, fullSpec);
        else target = resolveAbsoluteModule(fullSpec);
        // Fallback: if fullSpec unresolved, try resolving just baseSpec (package) as last resort
        if (!target) {
          if (baseSpec.startsWith('.')) target = resolveRelativeModule(f, baseSpec);
          else target = resolveAbsoluteModule(baseSpec);
        }
        if (!target) { if ((process.env.CRV_DEBUG||'').includes('py')) console.error(`[py] unresolved from-import ${fullSpec} in ${f}`); continue; }
        if ((process.env.CRV_DEBUG||'').includes('py')) console.error(`[py] from-import ${fullSpec} -> ${target}`);
        edges.push({ from: f, to: target, kind: 'import', lang: 'py' });
      }
    }
  }

  // If no edges resolved for this file and we want richer graph, attempt simple intra-package link by matching sibling imports
  // (skip if edges already found globally)
  }
  // Stage 2: if static engine, invoke external analyzer for potential future function-level integration (not yet merged into edges/nodes schema here).
  let staticResult: StaticAnalysisResult | undefined;
  if (opts.engine === 'static') {
    try {
      // Allow explicit override
      const override = process.env.CRABVIZ_PY_ANALYZER && existsSync(process.env.CRABVIZ_PY_ANALYZER) ? process.env.CRABVIZ_PY_ANALYZER : null;
  // Run analyzer separately per root (script only supports single --root); then merge JSON blobs
  const repoRoot = resolve(roots[0]);
      const candidates: string[] = [];
      if (override) candidates.push(override);
      // Walk upward from first root (may be external) just in case repo scripts dir is ancestor
      let cur = repoRoot;
      for (let i=0;i<6;i++) {
        candidates.push(resolve(cur, 'scripts', 'py_callscan.py'));
        const parent = resolve(cur, '..');
        if (parent === cur) break; cur = parent;
      }
      // Also walk upward from CLI package directory (handles external roots scenario)
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        let walk = here;
        for (let i=0;i<6;i++) {
          candidates.push(resolve(walk, '..', 'scripts', 'py_callscan.py'));
          candidates.push(resolve(walk, 'scripts', 'py_callscan.py'));
          const parent = resolve(walk, '..'); if (parent === walk) break; walk = parent;
        }
      } catch { /* ignore */ }
      // Add typical relative patterns
      candidates.push(resolve(process.cwd(), '..', 'scripts', 'py_callscan.py'));
      candidates.push(resolve(process.cwd(), '..','..', 'scripts', 'py_callscan.py'));
      // De-duplicate
      const seen = new Set<string>();
      const uniq = candidates.filter(c=> { const n=resolve(c); if (seen.has(n)) return false; seen.add(n); return true; });
      let scriptPath: string | null = null;
      for (const c of uniq) { if (existsSync(c)) { scriptPath = c; break; } }
      if (scriptPath) {
        const pyCmds = ['python','py'];
        let run;
        // Accumulate merged JSON across roots
        let merged: any = { functions: [], edges: [], unresolved_calls: [] };
        for (const rootDir of roots) {
          for (const cmd of pyCmds) {
            run = spawnSync(cmd, [scriptPath, '--root', resolve(rootDir), '--max-file-size', '1000000'], { encoding: 'utf-8' });
            if (!run.error) break;
          }
          if (run && run.status === 0) {
            try {
              const parsed = JSON.parse(run.stdout);
              merged.functions.push(...(parsed.functions||[]));
              merged.edges.push(...(parsed.edges||[]));
              merged.unresolved_calls.push(...(parsed.unresolved_calls||[]));
            } catch {}
          }
        }
    if (merged.functions.length) {
          run = { status:0, stdout: JSON.stringify(merged), error:undefined } as any;
        }
    if (run && run.status === 0 && run.stdout) {
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
            // Collapse function-level edges to file-level call edges for inclusion in main graph now
            try {
              if (parsed.edges && parsed.functions) {
                const funcToFile: Record<string,string> = {};
                for (const fn of parsed.functions) {
                  // Resolve module to path via moduleMap
                  let resolved = mMap[fn.module];
                  if (!resolved) {
                    // fallback approximate path
                    resolved = fn.module.split('.').join('/') + '.py';
                  }
                  funcToFile[fn.qualname] = resolved.replace(/\\/g,'/');
                }
                const added = new Set<string>();
                for (const edge of parsed.edges) {
                  const aFile = funcToFile[edge.caller];
                  const bFile = funcToFile[edge.callee];
                  if (!aFile || !bFile || aFile === bFile) continue;
                  const key = aFile + '::' + bFile;
                  if (added.has(key)) continue;
                  added.add(key);
                  edges.push({ from: aFile, to: bFile, kind: 'call', lang: 'py' });
                }
              }
            } catch(e:any) {
              console.error('[py-static] collapse edge error', e?.message||e);
            }
          } catch (e:any) {
            console.error('[py-static] failed to parse analyzer JSON', e?.message||e);
          }
        } else if (run) {
          console.error(`[py-static] analyzer failed status=${run.status} err=${run.error||''}`);
        }
      } else {
        console.error('[py-static] py_callscan.py not found; tried candidates:');
        for (const c of uniq.slice(0,15)) console.error('  - '+c);
        console.error('[py-static] set CRABVIZ_PY_ANALYZER env var to explicit path if needed');
      }
    } catch (e:any) {
      console.error('[py-static] error invoking analyzer', e?.message||e);
    }
  }
  return { nodes, edges, staticResult };
}
