import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Graph, File, Symbol, Relation } from './ui-graph-types.js';
import { RelationKind } from './ui-graph-types.js';

export interface StaticPyFunction { id:string; name:string; qualname:string; module:string; kind:string; lineno:number; endlineno:number; }
export interface StaticPyEdge { caller:string; callee:string; kind:string; provenance?:string; }
export interface StaticPyJson { functions: StaticPyFunction[]; edges: StaticPyEdge[]; modules_meta?: any[] }

let cache: { root:string; data: StaticPyJson } | null = null;

export function loadStaticPy(root:string): StaticPyJson | null {
  if (cache && cache.root === root) return cache.data;
  const scriptOutCandidates = [
    resolve(root, 'scripts', 'py_callscan.py'),
    resolve(root, '..', 'scripts', 'py_callscan.py')
  ];
  let analyzerPresent = false;
  for (const c of scriptOutCandidates) { if (existsSync(c)) { analyzerPresent = true; break; } }
  if (!analyzerPresent) return null;
  // Expect that lang-py.ts already invoked analyzer and printed summary; invoke it again here if JSON file caching becomes available (future stage).
  // For Stage 3 we rely on immediate run performed elsewhere (future improvement: write to temp file and reuse).
  return null; // actual invocation handled in buildStaticPyGraph via spawn for freshness
}

export function buildStaticPyGraph(jsonText:string, moduleMap?: Record<string,string>): Graph {
  const parsed: StaticPyJson = JSON.parse(jsonText);
  const filesByPath = new Map<string, File>();
  const symByQual = new Map<string, { file: File; symbol: Symbol }>();
  // Index functions by module -> name -> symbols (to support cross-root resolution)
  const byModuleName = new Map<string, Map<string, Symbol[]>>();
  for (const f of parsed.functions) {
    const path = resolveModuleToPath(f.module, moduleMap);
    let file = filesByPath.get(path);
    if (!file) { file = { id: -1, path, symbols: [] }; filesByPath.set(path, file); }
    const sym: Symbol = { name: f.name, kind: f.kind === 'method'? 6: 12, range: { start:{ line: f.lineno-1, character:0 }, end:{ line: f.endlineno-1, character:0 } }, children: [] };
    file.symbols.push(sym);
    symByQual.set(f.qualname, { file, symbol: sym });
    if (!byModuleName.has(f.module)) byModuleName.set(f.module, new Map());
    const m = byModuleName.get(f.module)!;
    const arr = m.get(f.name) || [];
    arr.push(sym);
    m.set(f.name, arr);
  }
  // Assign stable numeric ids
  let nextId = 0; for (const file of filesByPath.values()) file.id = nextId++;
  const relations: Relation[] = [];
  const relSeen = new Set<string>();
  let crossResolved = 0;
  let crossTried = 0; let crossAmbiguous = 0; let crossNoModule = 0; const crossSamples: any[] = [];
  // Pre-compute a set of project module roots to help skip obvious stdlib/external modules.
  const projectModules = new Set<string>(byModuleName.keys());
  const stdlibLikePrefixes = ['os','sys','json','re','typing','pathlib','collections','itertools','functools','asyncio','logging','datetime','http','urllib','inspect','subprocess','concurrent','multiprocessing','email','xml','xmlrpc','argparse','dataclasses','enum'];
  function looksExternal(mod:string): boolean {
    if (projectModules.has(mod)) return false;
    // Single segment stdlib/common external
    const first = mod.split('.')[0];
    if (stdlibLikePrefixes.includes(first)) return true;
    // Heuristic: camel or vendor-y top modules we don't have locally (requests, boto3, django, flask, fastapi, numpy, pandas, torch, google, azure, botocore)
    const externalFirst = ['requests','boto3','botocore','django','flask','fastapi','numpy','pandas','torch','google','azure','setuptools','pip','jinja2','sqlalchemy'];
    if (externalFirst.includes(first)) return true;
    return false;
  }
  for (const e of parsed.edges) {
    const from = symByQual.get(e.caller);
    let to = symByQual.get(e.callee);
    if (!from) continue; // caller must exist inside project
    if (!to) {
      // Only attempt cross-root resolution for provisional edges
      if (e.provenance && e.provenance.startsWith('provisional')) {
        const rawParts = e.callee.split('.');
        if (rawParts.length >= 2) {
          const funcName = rawParts[rawParts.length - 1];
          // Progressive prefix stripping: try longest to shortest module chain until we find project module.
          const attempted = new Set<string>();
          // 1. Try progressive prefix shortening (longest prefix first)
          for (let cut = rawParts.length - 1; cut >= 1 && !to; cut--) {
            const modName = rawParts.slice(0, cut).join('.');
            if (attempted.has(modName)) continue; attempted.add(modName);
            if (looksExternal(modName)) {
              // Skip clearly external modules early.
              continue;
            }
            const modMapEntry = byModuleName.get(modName);
            crossTried++;
            if (modMapEntry) {
              const cand = modMapEntry.get(funcName);
              if (cand && cand.length === 1) {
                const file = Array.from(filesByPath.values()).find(f=> f.symbols.includes(cand[0]));
                if (file) {
                  to = { file, symbol: cand[0] } as any;
                  crossResolved++;
                  if (crossSamples.length < 25 && (process.env.CRV_DEBUG||'').includes('cross')) {
                    crossSamples.push({ kind:'resolved', edge:e, module:modName, func:funcName, prefixAttempts: rawParts.length-1-cut });
                  }
                  // Tag provenance if not already set to a resolved cross variant
                  if (!e.provenance || e.provenance.startsWith('provisional')) {
                    e.provenance = 'static-cross';
                  }
                }
              } else if (cand && cand.length > 1) {
                crossAmbiguous++;
                if (crossSamples.length < 25 && (process.env.CRV_DEBUG||'').includes('cross')) {
                  crossSamples.push({ kind:'ambiguous', edge:e, module:modName, func:funcName, candidates:cand.length });
                }
                // Ambiguity: stop searching shorter prefixes (could produce misleading resolution)
                break;
              } else {
                // module found but function missing in this module, continue trying shorter prefixes
                if (crossSamples.length < 25 && (process.env.CRV_DEBUG||'').includes('cross')) {
                  crossSamples.push({ kind:'func-missing', edge:e, module:modName, func:funcName });
                }
              }
            } else {
              // Only count module-missing if the full longest prefix attempt; shorter prefixes might still match.
              if (cut === rawParts.length - 1) {
                crossNoModule++;
                if (crossSamples.length < 25 && (process.env.CRV_DEBUG||'').includes('cross')) {
                  crossSamples.push({ kind:'module-missing', edge:e, module:modName });
                }
              }
              // Keep trying shorter prefixes.
            }
          }
          // 2. If still unresolved, attempt suffix trimming (drop leading segments, keep function name suffix)
          if (!to) {
            for (let start = 1; start < rawParts.length - 1 && !to; start++) {
              const modName = rawParts.slice(start, rawParts.length - 1).join('.');
              if (!modName || attempted.has(modName)) continue; attempted.add(modName);
              if (looksExternal(modName)) continue;
              const modMapEntry = byModuleName.get(modName);
              if (!modMapEntry) continue; // don't count as missing; it's an exploratory suffix
              crossTried++;
              const cand = modMapEntry.get(funcName);
              if (cand && cand.length === 1) {
                const file = Array.from(filesByPath.values()).find(f=> f.symbols.includes(cand[0]));
                if (file) {
                  to = { file, symbol: cand[0] } as any;
                  crossResolved++;
                  if (crossSamples.length < 25 && (process.env.CRV_DEBUG||'').includes('cross')) {
                    crossSamples.push({ kind:'resolved-suffix', edge:e, module:modName, func:funcName, droppedLeading:start });
                  }
                  if (!e.provenance || e.provenance.startsWith('provisional')) {
                    e.provenance = 'static-cross';
                  }
                }
              } else if (cand && cand.length > 1) {
                crossAmbiguous++;
                if (crossSamples.length < 25 && (process.env.CRV_DEBUG||'').includes('cross')) {
                  crossSamples.push({ kind:'ambiguous-suffix', edge:e, module:modName, func:funcName, candidates:cand.length, droppedLeading:start });
                }
                break;
              }
            }
          }
        }
      }
    }
    if (!to) continue; // unresolved after attempts
    const key = `${from.file.id}:${from.symbol.range.start.line}->${to.file.id}:${to.symbol.range.start.line}`;
    if (relSeen.has(key)) continue;
    relSeen.add(key);
    relations.push({ from: { fileId: from.file.id, line: from.symbol.range.start.line, character: from.symbol.range.start.character }, to:{ fileId: to.file.id, line: to.symbol.range.start.line, character: to.symbol.range.start.character }, kind: RelationKind.Call, provenance: e.provenance || 'static-py' });
  }
  if ((process.env.CRV_DEBUG||'').includes('cross')) {
    console.error(`[static-cross] tried=${crossTried} resolved=${crossResolved} ambiguous=${crossAmbiguous} noModule=${crossNoModule}`);
    if (crossSamples.length) console.error('[static-cross-samples] ' + JSON.stringify(crossSamples, null, 2));
  }
  return { files: Array.from(filesByPath.values()), relations };
}
function resolveModuleToPath(mod:string, moduleMap?:Record<string,string>): string {
  if (moduleMap && moduleMap[mod]) return moduleMap[mod];
  return mod.split('.').join('/') + '.py';
}
