import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Graph, File, Symbol, Relation } from './ui-graph-types.js';
import { RelationKind } from './ui-graph-types.js';

export interface StaticPyFunction { id:string; name:string; qualname:string; module:string; kind:string; lineno:number; endlineno:number; }
export interface StaticPyEdge { caller:string; callee:string; kind:string; provenance:string; }
export interface StaticPyJson { functions: StaticPyFunction[]; edges: StaticPyEdge[]; }

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
  for (const f of parsed.functions) {
    const path = resolveModuleToPath(f.module, moduleMap);
    let file = filesByPath.get(path);
    if (!file) { file = { id: -1, path, symbols: [] }; filesByPath.set(path, file); }
    const sym: Symbol = { name: f.name, kind: f.kind === 'method'? 6: 12, range: { start:{ line: f.lineno-1, character:0 }, end:{ line: f.endlineno-1, character:0 } }, children: [] };
    file.symbols.push(sym);
    symByQual.set(f.qualname, { file, symbol: sym });
  }
  // Assign stable numeric ids
  let nextId = 0; for (const file of filesByPath.values()) file.id = nextId++;
  const relations: Relation[] = [];
  const relSeen = new Set<string>();
  for (const e of parsed.edges) {
    const from = symByQual.get(e.caller);
    const to = symByQual.get(e.callee);
    if (!from || !to) continue;
    const key = `${from.file.id}:${from.symbol.range.start.line}->${to.file.id}:${to.symbol.range.start.line}`;
    if (relSeen.has(key)) continue;
    relSeen.add(key);
    relations.push({ from: { fileId: from.file.id, line: from.symbol.range.start.line, character: from.symbol.range.start.character }, to:{ fileId: to.file.id, line: to.symbol.range.start.line, character: to.symbol.range.start.character }, kind: RelationKind.Call, provenance: 'static-py' });
  }
  return { files: Array.from(filesByPath.values()), relations };
}
function resolveModuleToPath(mod:string, moduleMap?:Record<string,string>): string {
  if (moduleMap && moduleMap[mod]) return moduleMap[mod];
  return mod.split('.').join('/') + '.py';
}
