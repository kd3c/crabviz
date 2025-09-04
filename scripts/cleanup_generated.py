#!/usr/bin/env python3
"""Remove analyzer/export temporary artifacts (logs, dot, json) from repo root.

Safeguards:
- Only deletes files matching known transient prefixes.
- Skips anything inside versioned source dirs (core/, packages/, scripts/, webview-ui/, examples/, test-data/).
"""
import os, sys
ROOT = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(ROOT, '..'))
TRANSIENT_PREFIXES = [
    'callgraph', 'symdot', 'symraw', 'symdump', 'symfix', 'symregr', 'sym',
    'pyscan_', 'multi_roots', 'out', 'edges', 'dotlog', 'pyquiet', 'pysmall'
]
TRANSIENT_EXACT = {
    'multi_roots.dot','multi_roots_run.log','pyscan_test.dot','pyscan_test.json'
}
ALLOWED_EXT = {'.log','.dot','.json'}
removed = []
for name in os.listdir(ROOT):
    path = os.path.join(ROOT, name)
    if not os.path.isfile(path):
        continue
    base, ext = os.path.splitext(name)
    if name in TRANSIENT_EXACT or any(base.startswith(p) for p in TRANSIENT_PREFIXES):
        if ext in ALLOWED_EXT:
            try:
                os.remove(path)
                removed.append(name)
            except OSError:
                pass
print(f"Removed {len(removed)} transient files: {', '.join(sorted(removed))}")
