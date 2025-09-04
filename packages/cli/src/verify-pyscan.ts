import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Simple verification harness for Stage 1 static Python call scanner.
function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..', '..', '..'); // dist -> cli -> packages -> repo root
  const scriptPath = path.resolve(repoRoot, 'scripts', 'py_callscan.py');
  const sampleRoot = path.resolve(repoRoot, 'test-data', 'py-mini');
  if (!fs.existsSync(scriptPath)) {
    console.error('Missing py_callscan.py at', scriptPath);
    process.exit(1);
  }
  const pyCmds = ['python', 'py'];
  let result; let used: string | undefined;
  for (const cmd of pyCmds) {
    result = spawnSync(cmd, [scriptPath, '--root', sampleRoot], { encoding: 'utf-8' });
    if (result.error) continue;
    used = cmd; break;
  }
  if (!result || result.error) {
    console.error('Failed to run Python interpreter:', result?.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('Scanner exited with code', result.status, '\nSTDERR:\n', result.stderr);
    process.exit(result.status ?? 1);
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (e) {
    console.error('Failed to parse JSON output:', e, '\nRaw:\n', result.stdout.slice(0, 500));
    process.exit(1);
  }
  const funcs = data.functions?.length ?? 0;
  const edges = data.edges?.length ?? 0;
  if (funcs < 5) {
    console.error('Expected at least 5 functions, got', funcs);
    process.exit(1);
  }
  if (edges < 3) {
    console.error('Expected at least 3 edges, got', edges);
    process.exit(1);
  }
  console.log('verify-pyscan OK using', used, `functions=${funcs} edges=${edges}`);
}

main();
