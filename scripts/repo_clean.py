#!/usr/bin/env python3
"""Comprehensive repository cleanup for transient / generated artifacts.

Safe removals only. Does NOT touch source (core/, packages/*/src, webview-ui/src, examples/, test-data/).

Removes:
  - node_modules depth>1 optional (flag --deep-node)
  - dist/, build/, out/, coverage/, .nyc_output/ under packages and webview-ui
  - tmp/ HTML exports older than N days (default 14)
  - analyzer scratch files (*.dot, *_graph.html, *_graph.dot, out*.json, err*.txt) in packages/cli
  - root-level transient files matched by cleanup_generated.py logic

Usage:
  python scripts/repo_clean.py            # basic
  python scripts/repo_clean.py --deep-node # also remove nested node_modules
  python scripts/repo_clean.py --days 7    # keep last week only in tmp/
"""
from __future__ import annotations
import os, sys, time, argparse, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent

TRANSIENT_FILES_PATTERNS = [
    'out*.json','err*.txt','pyscan_*.json','pyscan_*.txt','*_graph.html','*_graph.dot'
]
TRANSIENT_EXT = {'.dot','.log','.json'}
TRANSIENT_PREFIXES = [
    'callgraph','symdot','symraw','symdump','symfix','symregr','sym','pyscan_','multi_roots','out','edges','dotlog','pyquiet','pysmall'
]

PRUNE_DIR_NAMES = {'dist','build','out','coverage','.nyc_output','reports'}

parser = argparse.ArgumentParser()
parser.add_argument('--deep-node', action='store_true', help='Remove nested node_modules (except top-level ones)')
parser.add_argument('--days', type=int, default=14, help='Age threshold for tmp/ html removal')
args = parser.parse_args()

now = time.time()
removed_files: list[Path] = []
removed_dirs: list[Path] = []

def rm_file(p:Path):
    try:
        p.unlink()
        removed_files.append(p)
    except OSError:
        pass

def rm_dir(p:Path):
    try:
        shutil.rmtree(p)
        removed_dirs.append(p)
    except OSError:
        pass

# 1. Root transient files
for item in ROOT.iterdir():
    if item.is_file():
        base = item.stem
        if item.suffix in TRANSIENT_EXT and any(base.startswith(pref) for pref in TRANSIENT_PREFIXES):
            rm_file(item)

# 2. packages/cli analyzer artifacts
cli_dir = ROOT / 'packages' / 'cli'
if cli_dir.exists():
    import fnmatch
    for pat in TRANSIENT_FILES_PATTERNS:
        for f in cli_dir.glob(pat):
            rm_file(f)

# 3. Build output directories
for pkg_parent in ['packages','webview-ui','core']:
    d = ROOT / pkg_parent
    if not d.exists():
        continue
    for path, dirs, files in os.walk(d):
        p = Path(path)
        name = p.name
        if name in PRUNE_DIR_NAMES and p.is_dir():
            rm_dir(p)
            continue
        if args.deep_node and name == 'node_modules':
            # Skip top-level webview-ui/node_modules removal to save reinstall unless deep-node
            rm_dir(p)

# 4. tmp/ age-based pruning
TMP = ROOT / 'tmp'
if TMP.exists():
    cutoff = now - args.days*86400
    for f in TMP.iterdir():
        if f.is_file() and f.suffix in {'.html','.dot'}:
            try:
                if f.stat().st_mtime < cutoff:
                    rm_file(f)
            except OSError:
                pass

print(f"Removed files: {len(removed_files)}; Removed dirs: {len(removed_dirs)}")
if removed_files:
    print('  Files:')
    for f in removed_files:
        print('   -', f.relative_to(ROOT))
if removed_dirs:
    print('  Dirs:')
    for d in removed_dirs:
        print('   -', d.relative_to(ROOT))
