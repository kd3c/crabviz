#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchPyright, launchTsServer } from './lsp-manager.js';
import { scanTs } from './lang-ts.js';
import { scanPy } from './lang-py.js';
import { mergeGraphs, toDot } from './graph.js';
import { dotToHtml } from './html.js';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('roots', { type: 'array', demandOption: true, desc: 'Root folders' })
    .option('out', { type: 'string', demandOption: true, desc: 'Output HTML file' })
    .option('simplified', { type: 'boolean', default: false })
    .help().argv as unknown as { roots: string[]; out: string; simplified: boolean };

  const roots = argv.roots.map(r => resolve(String(r)));

  const tsClient = await launchTsServer(roots[0]);
  const pyClient = await launchPyright(roots[0]);

  try {
    const tsPart = await scanTs(roots, tsClient);
    const pyPart = await scanPy(roots, pyClient);

    const gd = mergeGraphs([tsPart, pyPart]);
    const dot = toDot(gd, argv.simplified);
    const html = await dotToHtml(dot);

    const outPath = resolve(argv.out);
    writeFileSync(outPath, html);
    console.log(`Wrote ${outPath}`);
  } finally {
    tsClient.dispose();
    pyClient.dispose();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
