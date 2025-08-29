import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LspClient } from './lsp-manager.js';
import { Edge, NodeInfo } from './types.js';

const importRe = /^\s*(?:from\s+([.\w]+)\s+import\s+[\w*,\s]+|import\s+([\w.]+))/gm;

export async function scanPy(
  roots: string[],
  client: LspClient
): Promise<{ nodes: NodeInfo[]; edges: Edge[] }> {
  const files = await fg(roots.map(r => `${r.replace(/\\/g,'/')}/**/*.py`), { dot:false });
  const nodes: NodeInfo[] = [];
  const edges: Edge[] = [];

  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    nodes.push({ id: f, lang: 'py' });
    await client.didOpen(f, 'python', text);

    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text))) {
      const spec = (m[1] || m[2])?.trim();
      if (!spec) continue;
      const to = spec.startsWith('.') ? resolve(dirname(f), spec.replace(/\./g, '/')) : spec;
      edges.push({ from: f, to, kind: 'import', lang: 'py' });
    }
  }
  return { nodes, edges };
}
