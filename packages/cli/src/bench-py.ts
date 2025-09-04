#!/usr/bin/env node
// Benchmark harness for scripts/py_callscan.py across multiple worker counts.
// Usage (PowerShell example):
//   node dist/bench-py.js --roots "C:/path/With Spaces/Common" "C:/path/With Spaces/FilterRun" --workers 1,2,4,8 --repeat 2 --max-file-size 1500000 --cache
// Produces JSON summary with timing + throughput.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

interface Args { roots:string[]; workers:string; repeat:number; maxFileSize:number; cache:boolean; out?:string; quiet?:boolean; }

function findScript(start:string): string | null {
  const attempts:string[] = [];
  let cur = resolve(start);
  for (let i=0;i<6;i++) {
    attempts.push(resolve(cur, 'scripts', 'py_callscan.py'));
    const parent = resolve(cur, '..');
    if (parent === cur) break; cur = parent;
  }
  attempts.push(resolve(process.cwd(), 'scripts', 'py_callscan.py'));
  for (const a of attempts) if (existsSync(a)) return a;
  return null;
}

async function main(){
  const argv = (await yargs(hideBin(process.argv))
    .option('roots',{ type:'array', demandOption:true, describe:'Root directories to scan (Python packages)'} )
    .option('workers',{ type:'string', default:'1,2,4', describe:'Comma list of worker counts to benchmark'})
    .option('repeat',{ type:'number', default:1, describe:'Repeat each worker configuration N times'})
    .option('max-file-size',{ type:'number', default:1_000_000, describe:'Max file size passed to analyzer'})
    .option('cache',{ type:'boolean', default:false, describe:'Enable analyzer JSON cache file between repeats (--cache-file) to test incremental speed'})
    .option('out',{ type:'string', describe:'Write JSON summary to this file'})
    .option('quiet',{ type:'boolean', default:false })
    .help().argv) as unknown as Args;

  const script = findScript(process.cwd());
  if (!script) {
    console.error('[bench-py] Cannot locate scripts/py_callscan.py');
    process.exit(1);
  }

  const workerList = argv.workers.split(',').map(s=> Number(s.trim())).filter(n=> n>0);
  if (!workerList.length) { console.error('[bench-py] No valid worker counts'); process.exit(1); }

  const roots = argv.roots.map(r=> String(r));
  const cacheFile = argv.cache ? resolve('.py_scan_cache.json') : null;

  const results: any[] = [];
  for (const w of workerList) {
    for (let iter=0; iter<argv.repeat; iter++) {
      const start = process.hrtime.bigint();
      const args = [script, '--root', roots[0], '--workers', String(w), '--max-file-size', String(argv.maxFileSize)];
      // Additional roots passed as extra --root
      for (const extra of roots.slice(1)) { args.push('--root', extra); }
      if (cacheFile) { args.push('--cache-file', cacheFile); }
      const run = spawnSync('python', args, { encoding:'utf-8' });
      const end = process.hrtime.bigint();
      const elapsedMs = Number(end - start)/1e6;
      if (run.status !== 0) {
        console.error(`[bench-py] run failed workers=${w} iter=${iter} status=${run.status} stderr=${run.stderr.slice(0,400)}`);
        results.push({ workers:w, iter, error:true, status:run.status, elapsedMs });
        continue;
      }
      let parsed:any = {};
      try { parsed = JSON.parse(run.stdout); } catch { /* ignore */ }
      const fileCount = parsed.files?.length ?? parsed.functions?.length ?? 0;
      const edgeCount = parsed.edges?.length ?? 0;
      const unresolved = parsed.unresolved_calls?.length ?? 0;
      const throughput = fileCount ? (fileCount / (elapsedMs/1000)) : 0;
      results.push({ workers:w, iter, elapsedMs, fileCount, edgeCount, unresolved, throughput });
      if (!argv.quiet) console.error(`[bench-py] workers=${w} iter=${iter} time=${elapsedMs.toFixed(1)}ms files=${fileCount} edges=${edgeCount} thr=${throughput.toFixed(1)} f/s`);
    }
  }

  // Aggregate by worker count
  const agg = new Map<number, any>();
  for (const r of results.filter(r=> !r.error)) {
    const a = agg.get(r.workers) || { workers:r.workers, runs:0, totalMs:0, totalFiles:0, totalThroughput:0 };
    a.runs++; a.totalMs += r.elapsedMs; a.totalFiles += r.fileCount; a.totalThroughput += r.throughput; agg.set(r.workers, a);
  }
  const summary = Array.from(agg.values()).map(a=> ({ workers:a.workers, avgMs: a.totalMs / a.runs, avgThroughput: a.totalThroughput / a.runs }));
  const outObj = { roots, repeats: argv.repeat, results, summary };
  if (argv.out) {
    try { await import('node:fs').then(m=> m.writeFileSync(argv.out!, JSON.stringify(outObj, null, 2),'utf8')); } catch {}
  }
  if (!argv.quiet) console.log(JSON.stringify(outObj, null, 2));
  else process.stdout.write(JSON.stringify(outObj));
}

main().catch(e=> { console.error('[bench-py] error', e?.message||e); process.exit(1); });
