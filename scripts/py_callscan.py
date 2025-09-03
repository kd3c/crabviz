#!/usr/bin/env python3
"""Static Python call scanner (Stage 1).

Outputs JSON with:
{
  "engine": "static-pyscan",
  "version": 1,
  "generated_at": ISO8601,
  "root": scan root,
  "files": N processed files,
  "skipped": {"size": int, "parse": int},
  "functions": [
     {"id": qual, "name": simple, "qualname": qual, "module": module, "kind": "function|method",
      "lineno": int, "endlineno": int}
  ],
  "edges": [
     {"caller": qual, "callee": qual, "kind": "call", "provenance": "static-pyscan"}
  ],
  "unresolved_calls": [ {"caller": qual, "name": target_name} ]
}

Resolution Stage 1 limitations:
- Only resolves intra-module simple name calls and self.method() within same class.
- Ignores imports, aliases, decorators, dynamic constructs.
"""

from __future__ import annotations
import argparse, ast, json, os, sys, time, hashlib, builtins
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


EXCLUDE_DIRS = {"__pycache__", ".git", ".venv", "env", "venv", "build", "dist"}


@dataclass
class FunctionInfo:
    id: str
    name: str
    qualname: str
    module: str
    kind: str  # function | method
    lineno: int
    endlineno: int


@dataclass
class Edge:
    caller: str
    callee: str
    kind: str = "call"
    provenance: str = "static-pyscan"


@dataclass
class UnresolvedCall:
    caller: str
    name: str


class ModuleScanner(ast.NodeVisitor):
    def __init__(self, module: str, module_path: str):
        self.module = module
        self.module_path = module_path
        # Collections
        self.stack = []              # class / function nesting
        self.functions = []          # collected FunctionInfo
        self.edges = []              # collected Edge objects
        self.unresolved = []         # unresolved call targets
        self.name_index = {}         # simple name -> [qualnames]
        self.class_methods = {}      # class qual -> {method names}
        self.current_func = []       # call stack of qualified function names
        # Import alias tracking
        self.imported_modules = {}   # alias -> module
        self.imported_names = {}     # local name -> module.symbol
        # Diagnostics (per module scan)
        self.diag_cross_alias = []   # alias.func() provisional targets
        self.diag_from_import = []   # from-import symbol provisional targets

    # Utility
    def _qual(self, name: str) -> str:
        parts = [self.module] + self.stack + [name]
        return ".".join(p for p in parts if p)

    def _add_function(self, node: ast.AST, name: str, kind: str):
        qual = self._qual(name)
        endlineno = getattr(node, 'end_lineno', node.lineno)
        info = FunctionInfo(
            id=qual,
            name=name,
            qualname=qual,
            module=self.module,
            kind=kind,
            lineno=node.lineno,
            endlineno=endlineno,
        )
        self.functions.append(info)
        self.name_index.setdefault(name, []).append(qual)

    # Visits
    def visit_ClassDef(self, node: ast.ClassDef):
        self.stack.append(node.name)
        self.class_methods.setdefault(self._qual(""), set())  # class scope placeholder
        # Pre-register method names for self lookup
        for stmt in node.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.class_methods[self._qual("")].add(stmt.name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef):  # noqa: N802
        kind = "method" if self.stack and isinstance(node.parent, ast.ClassDef) else "function"
        # Avoid duplicate add if pre-scan already registered this top-level function
        if not any(f.qualname.endswith('.' + node.name) and f.lineno == node.lineno for f in self.functions):
            self._add_function(node, node.name, kind)
        self.stack.append(node.name)
        current_qual = ".".join([self.module] + self.stack)
        self.current_func.append(current_qual)
        self.generic_visit(node)
        self.current_func.pop()
        self.stack.pop()

    # Imports
    def visit_Import(self, node: ast.Import):  # type: ignore[override]
        for alias in node.names:
            if alias.asname:
                self.imported_modules[alias.asname] = alias.name
            else:
                # bare import x.y -> module name before dot becomes alias
                root = alias.name.split('.')[0]
                self.imported_modules[root] = root
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):  # type: ignore[override]
        if node.module is None:
            return  # relative import without module part: handled earlier
        mod = '.' * (node.level or 0) + node.module if node.level else node.module
        for alias in node.names:
            local = alias.asname or alias.name
            self.imported_names[local] = f"{mod}.{alias.name}"
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):  # noqa: N802
        self.visit_FunctionDef(node)  # treat same

    def visit_Call(self, node: ast.Call):
        if not self.current_func:
            return
        caller = self.current_func[-1]
        target_name, resolved_qual, provenance = self._resolve_call(node)
        if resolved_qual:
            self.edges.append(Edge(caller=caller, callee=resolved_qual))
        else:
            if provenance and target_name:
                # Emit provisional edge so later phase can attempt cross-root resolution
                self.edges.append(Edge(caller=caller, callee=target_name, provenance=provenance))
            elif target_name:
                self.unresolved.append(UnresolvedCall(caller=caller, name=target_name))
        self.generic_visit(node)

    # Resolution helpers
    def _resolve_call(self, node: ast.Call) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        func = node.func
        # Simple name foo()
        if isinstance(func, ast.Name):
            name = func.id
            matches = self.name_index.get(name)
            if matches:
                if len(matches) > 1 and self.stack:
                    for m in matches:
                        if m.startswith(self.module + "." + ".".join(self.stack[:-1])):
                            return name, m, None
                return name, matches[0], None
            if name in self.imported_names:
                # imported symbol (from X import name) – produce provisional cross-module qual
                full = self.imported_names[name]
                self.diag_from_import.append({'caller': self.current_func[-1] if self.current_func else None, 'symbol': name, 'target': full})
                return full, None, 'provisional-fromimport'
            return name, None, None
        # Attribute: self.method() inside class
        if isinstance(func, ast.Attribute):
            attr = func.attr
            # self.method()
            if isinstance(func.value, ast.Name) and func.value.id == 'self':
                # Determine current class
                cls_parts = []
                for element in self.stack:
                    # last class before current function
                    cls_parts.append(element)
                # class name is second last if current top is function
                if len(cls_parts) >= 2:
                    class_name = cls_parts[-2]
                    class_qual = ".".join([self.module] + cls_parts[:-1])
                    methods = self.class_methods.get(class_qual)
                    if methods and attr in methods:
                        # Build method qual
                        qual = f"{class_qual}.{attr}"
                        return attr, qual, None
            # moduleAlias.func()
            if isinstance(func.value, ast.Name):
                mod_alias = func.value.id
                if mod_alias in self.imported_modules:
                    mod_full = self.imported_modules[mod_alias]
                    full = f"{mod_full}.{attr}"
                    self.diag_cross_alias.append({'caller': self.current_func[-1] if self.current_func else None, 'alias': mod_alias, 'module': mod_full, 'attr': attr, 'target': full})
                    return full, None, 'provisional-alias'
            # Fallback unresolved attribute; return final attr name
            return attr, None, None
        return None, None, None


def add_parents(node: ast.AST):
    for child in ast.iter_child_nodes(node):
        child.parent = node  # type: ignore[attr-defined]
        add_parents(child)


def module_name(root: str, file_path: str) -> str:
    rel = os.path.relpath(file_path, root).replace("\\", "/")
    if rel.endswith("/__init__.py"):
        rel = rel[:-12]  # remove /__init__.py
    elif rel.endswith(".py"):
        rel = rel[:-3]
    parts = [p for p in rel.split('/') if p and p not in ('.',)]
    return ".".join(parts)


def scan_file(root: str, path: str, max_file_size: int):
    try:
        if os.path.getsize(path) > max_file_size:
            return None, 'size'
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            src = f.read()
        tree = ast.parse(src, filename=path)
        add_parents(tree)
        mod = module_name(root, path)
        scanner = ModuleScanner(mod, path)
        # First pass: register top-level functions & classes (for forward references)
        for stmt in tree.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                scanner._add_function(stmt, stmt.name, 'function')
            elif isinstance(stmt, ast.ClassDef):
                for sub in stmt.body:
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        # Pre-register method under its future qual
                        qual = ".".join([mod, stmt.name, sub.name])
                        scanner.name_index.setdefault(sub.name, []).append(qual)
        scanner.visit(tree)
        return scanner, None
    except Exception:
        return None, 'parse'


def iter_py_files(root: str, skip_dirs: List[str]):
    skip_set = {s.rstrip('/').rstrip('\\') for s in skip_dirs}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and d not in skip_set]
        # Quick skip: if any skip pattern contained as component
        if any(part in skip_set for part in dirpath.replace('\\','/').split('/')):
            continue
        for fn in filenames:
            if fn.endswith('.py'):
                yield os.path.join(dirpath, fn)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description='Static Python call scanner (Stage 1)')
    ap.add_argument('--root', default='.', help='Root directory to scan')
    ap.add_argument('--out', help='Write JSON output to file')
    ap.add_argument('--max-file-size', type=int, default=1_000_000, help='Skip files larger than this (bytes)')
    ap.add_argument('--workers', type=int, default=1, help='Worker processes for parallel parsing')
    ap.add_argument('--skip-dir', action='append', default=[], help='Directory name to skip (repeatable)')
    ap.add_argument('--cache-file', help='Path to incremental cache JSON (read & update)')
    ap.add_argument('--hash-mode', choices=['stat','sha1'], default='stat', help='File hashing mode for cache reuse (stat=mtime:size, sha1=content digest)')
    ap.add_argument('--ignore-builtin-unresolved', action='store_true', help='Drop unresolved calls whose name matches a Python builtin')
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    functions: List[FunctionInfo] = []
    edges: List[Edge] = []
    unresolved: List[UnresolvedCall] = []
    modules_meta: List[Dict] = []
    imported_candidates: List[Tuple[str,str]] = []  # (caller, fullExternalName)
    files_processed = 0
    skipped_size = 0
    skipped_parse = 0
    # Aggregate diagnostics
    diag_cross_alias: List[Dict] = []
    diag_from_import: List[Dict] = []

    file_hashes: Dict[str,str] = {}
    paths = list(iter_py_files(root, args.skip_dir))

    # Incremental cache load (structure: cache_units[file_rel] = {hash, functions, edges, unresolved_calls})
    prev_cache_units: Dict[str, dict] = {}
    cache_units: Dict[str, dict] = {}
    reused_files = reused_functions = reused_edges = reused_unresolved = 0
    cache_pruned = 0
    prev_hash_mode = None
    if args.cache_file and os.path.exists(args.cache_file):
        try:
            with open(args.cache_file, 'r', encoding='utf-8') as cf:
                prev = json.load(cf)
            prev_cache_units = prev.get('cache_units', {}) or {}
            prev_hash_mode = prev.get('hash_mode')
        except Exception:
            prev_cache_units = {}

    # Precompute stat-hash for all paths so we can decide reuse without parsing
    def compute_hash(p: str) -> str:
        if args.hash_mode == 'stat':
            try:
                st = os.stat(p)
                return f"{int(st.st_mtime)}:{st.st_size}"
            except OSError:
                return '0:0'
        # sha1 mode
        try:
            h = hashlib.sha1()
            with open(p, 'rb') as f:
                while True:
                    chunk = f.read(8192)
                    if not chunk:
                        break
                    h.update(chunk)
            return h.hexdigest()
        except Exception:
            return '0'

    # Paths to actually parse this run
    to_parse: List[Tuple[str,str]] = []  # (abs_path, hash)
    for p in paths:
        rel = os.path.relpath(p, root).replace('\\','/')
        h = compute_hash(p)
        unit = prev_cache_units.get(rel)
        # Only reuse if hash matches AND hash mode identical (or cache lacked mode but current is stat for backward compat)
        if unit and unit.get('hash') == h and (prev_hash_mode in (None, args.hash_mode) or (prev_hash_mode is None and args.hash_mode=='stat')):
            # Reuse unit contents
            file_hashes[rel] = h
            cache_units[rel] = unit
            reused_files += 1
            f_list = unit.get('functions', [])
            e_list = unit.get('edges', [])
            u_list = unit.get('unresolved_calls', [])
            reused_functions += len(f_list)
            reused_edges += len(e_list)
            reused_unresolved += len(u_list)
            for f in f_list:
                try:
                    functions.append(FunctionInfo(**f))
                except TypeError:
                    # schema drift safeguard
                    pass
            for e in e_list:
                try:
                    edges.append(Edge(**e))
                except TypeError:
                    pass
            for u in u_list:
                try:
                    unresolved.append(UnresolvedCall(**u))
                except TypeError:
                    pass
        else:
            to_parse.append((p,h))

    # If everything reused we can skip scanning entirely
    if not to_parse:
        files_processed = reused_files  # all reused
        # Build output directly later (skip parsing section below)
    
    if to_parse:
        # Optional concurrency for remaining files
        edge_cap = int(os.getenv('CRV_PY_EDGE_CAP') or 0) or None
        def process(path:str):
            scanner, reason = scan_file(root, path, args.max_file_size)
            if scanner is None:
                return path, reason, None
            # hash already computed pre; but recompute to remain robust
            try:
                st = os.stat(path)
                h2 = f"{int(st.st_mtime)}:{st.st_size}"
            except OSError:
                h2 = '0:0'
            return path, None, (scanner, h2)
        results = []
        parse_paths = [p for p,_ in to_parse]
        if args.workers and args.workers > 1:
            try:
                from concurrent.futures import ThreadPoolExecutor, as_completed
                with ThreadPoolExecutor(max_workers=args.workers) as ex:
                    futs = { ex.submit(process, p): p for p in parse_paths }
                    for fut in as_completed(futs):
                        try:
                            results.append(fut.result())
                        except Exception:
                            results.append((futs[fut],'parse',None))
            except Exception:
                results = [process(p) for p in parse_paths]
        else:
            results = [process(p) for p in parse_paths]

        for path, reason, payload in results:
            rel = os.path.relpath(path, root).replace('\\','/')
            if payload is None:
                if reason == 'size': skipped_size += 1
                else: skipped_parse += 1
                continue
            scanner, h = payload
            file_hashes[rel] = h
            files_processed += 1
            functions.extend(scanner.functions)
            edges.extend(scanner.edges)
            unresolved.extend(scanner.unresolved)
            modules_meta.append({
                'module': scanner.module,
                'imports': scanner.imported_modules,
                'from_imports': scanner.imported_names
            })
            if scanner.diag_cross_alias:
                diag_cross_alias.extend(scanner.diag_cross_alias)
            if scanner.diag_from_import:
                diag_from_import.extend(scanner.diag_from_import)
            # Build unit for cache
            cache_units[rel] = {
                'hash': h,
                'functions': [fi.__dict__ for fi in scanner.functions],
                'edges': [e.__dict__ for e in scanner.edges],
                'unresolved_calls': [u.__dict__ for u in scanner.unresolved],
            }
            for u in scanner.unresolved:
                if '.' in u.name and not u.name.startswith(scanner.module + '.'):
                    imported_candidates.append((u.caller, u.name))
            if edge_cap and len(edges) >= edge_cap:
                break

    # Ensure reused units are represented in cache_units for output
    if prev_cache_units:
        # Prune entries for files that disappeared
        for rel in list(prev_cache_units.keys()):
            if rel not in {os.path.relpath(p, root).replace('\\','/') for p in paths}:
                cache_pruned += 1
        # Ensure reused units are in cache units already (done during reuse loop)
        for rel, unit in prev_cache_units.items():
            if rel not in cache_units and rel in file_hashes:
                cache_units[rel] = unit

    out = {
        'engine': 'static-pyscan',
        'version': 1,
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'root': root,
        'files': files_processed,
        'skipped': {'size': skipped_size, 'parse': skipped_parse},
        'functions': [fi.__dict__ for fi in functions],
    'edges': [e.__dict__ for e in edges],
    'unresolved_calls': [u.__dict__ for u in unresolved],
    'modules_meta': modules_meta,
        'file_hashes': file_hashes,
        'workers': args.workers,
    }

    if args.cache_file:
        out['cache_units'] = cache_units
        out['cache'] = {
            'reused_files': reused_files,
            'reused_functions': reused_functions,
            'reused_edges': reused_edges,
            'reused_unresolved': reused_unresolved,
            'parsed_files': files_processed - reused_files,
            'pruned_files': cache_pruned,
        }
        out['hash_mode'] = args.hash_mode

    # Second pass: external resolution for imported function calls
    func_set = {f.qualname for f in functions}
    simple_index: Dict[str, List[str]] = {}
    for f in functions:
        simple_index.setdefault(f.name, []).append(f.qualname)

    new_edges_imported = 0
    imported_missing = 0
    imported_dotted_hist: Dict[str,int] = {}
    for caller, full in imported_candidates:
        base_mod = full.split('.')[0]
        imported_dotted_hist[base_mod] = imported_dotted_hist.get(base_mod, 0) + 1
        if full in func_set:
            edges.append(Edge(caller=caller, callee=full, provenance='static-cross-import'))
            new_edges_imported += 1
        else:
            imported_missing += 1

    # Cross-module resolution for unresolved entries
    resolved_cross = 0
    builtin_ignored = 0
    builtin_names = set(dir(builtins)) if args.ignore_builtin_unresolved else set()
    remaining_unresolved: List[UnresolvedCall] = []
    top_modules = {f.module.split('.')[0] for f in functions if f.module}
    unresolved_hist: Dict[str,int] = {}
    for u in unresolved:
        name = u.name.lstrip('.') if u.name else u.name
        if args.ignore_builtin_unresolved and name in builtin_names:
            builtin_ignored += 1
            continue
        target = None
        candidates = []
        if name:
            candidates.append(name)
            # If dotted but not fully qualified with top module, try prefix
            if '.' in name:
                for tm in top_modules:
                    candidates.append(f"{tm}.{name}")
            first = name.split('.')[0]
            unresolved_hist[first] = unresolved_hist.get(first, 0) + 1
        matched = None
        for cand in candidates:
            if cand in func_set:
                matched = cand
                break
            # Fallback: suffix match (unique)
            suffix_matches = [fq for fq in func_set if fq.endswith('.'+cand)]
            if len(suffix_matches) == 1:
                matched = suffix_matches[0]
                break
        if matched:
            edges.append(Edge(caller=u.caller, callee=matched, provenance='static-cross-module'))
            resolved_cross += 1
        else:
            remaining_unresolved.append(u)

    unresolved = remaining_unresolved
    out['unresolved_calls'] = [u.__dict__ for u in unresolved]
    out['edges'] = [e.__dict__ for e in edges]
    if new_edges_imported:
        out['resolved_external'] = new_edges_imported
    if imported_missing:
        out['imported_missing'] = imported_missing
        out['imported_candidates'] = len(imported_candidates)
    if imported_dotted_hist:
        out['imported_hist'] = sorted(imported_dotted_hist.items(), key=lambda x: x[1], reverse=True)[:15]
    if resolved_cross:
        out['resolved_cross_module'] = resolved_cross
    if builtin_ignored:
        out['ignored_builtins'] = builtin_ignored

    out['diag'] = {
        'cross_alias_total': len(diag_cross_alias),
        'from_import_total': len(diag_from_import),
        'cross_alias_samples': diag_cross_alias[:25],
        'from_import_samples': diag_from_import[:25],
        'unresolved_hist': sorted(unresolved_hist.items(), key=lambda x: x[1], reverse=True)[:20],
    }
    data = json.dumps(out, indent=2, sort_keys=True)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(data)
    else:
        print(data)
    if args.cache_file:
        try:
            with open(args.cache_file, 'w', encoding='utf-8') as cf:
                cf.write(data)
        except Exception:
            pass
    # Stats line for logs
    stats_line = (
        f"PYSCAN_STATS files={files_processed} functions={len(functions)} edges={len(edges)} "
        f"unresolved={len(unresolved)} reused_files={reused_files} parsed_files={files_processed - reused_files} "
        f"resolved_cross={out.get('resolved_cross_module',0)} imported_resolved={out.get('resolved_external',0)} "
        f"imported_missing={out.get('imported_missing',0)} ignored_builtins={out.get('ignored_builtins',0)} pruned={cache_pruned}"
    )
    sys.stderr.write(stats_line + "\n")
    if (os.getenv('CRV_DEBUG') or '').find('pyscan') != -1:
        sys.stderr.write('[pyscan-diag] ' + json.dumps({
            'cross_alias_total': len(diag_cross_alias),
            'from_import_total': len(diag_from_import),
            'imported_candidates': len(imported_candidates),
            'imported_missing': out.get('imported_missing',0),
            'resolved_external': out.get('resolved_external',0),
            'resolved_cross_module': out.get('resolved_cross_module',0),
            'unresolved_hist_top': out['diag']['unresolved_hist']
        }) + '\n')
    return 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())
