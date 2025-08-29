import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LspClient } from './lsp-manager.js';
import { Edge, NodeInfo } from './types.js';

const importRe = /\bimport\s+(?:[\s\S]+?)\s+from\s+['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

export async function scanTs(
  roots: string[],
  client: LspClient
): Promise<{ nodes: NodeInfo[]; edges: Edge[] }> {
  const files = await fg(roots.map(r => `${r.replace(/\\/g,'/')}/**/*.{ts,tsx,js,jsx}`), { dot:false });
  const nodes: NodeInfo[] = [];
  const edges: Edge[] = [];

  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    nodes.push({ id: f, lang: 'ts' });
    await client.didOpen(f, 'typescript', text);

    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text))) {
      const spec = m[1] || m[2] || m[3];
      if (!spec) continue;
      const to = spec.startsWith('.') ? resolve(dirname(f), spec) : spec;
      edges.push({ from: f, to, kind: 'import', lang: 'ts' });
    }
  }
  return { nodes, edges };
}
