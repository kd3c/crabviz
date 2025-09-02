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
import argparse, ast, json, os, sys, time
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
        target_name, resolved_qual = self._resolve_call(node)
        if resolved_qual:
            self.edges.append(Edge(caller=caller, callee=resolved_qual))
        else:
            if target_name:
                self.unresolved.append(UnresolvedCall(caller=caller, name=target_name))
        self.generic_visit(node)

    # Resolution helpers
    def _resolve_call(self, node: ast.Call) -> Tuple[Optional[str], Optional[str]]:
        func = node.func
        # Simple name foo()
        if isinstance(func, ast.Name):
            name = func.id
            matches = self.name_index.get(name)
            if matches:
                # Prefer function in same innermost class scope if multiple
                if len(matches) > 1 and self.stack:
                    for m in matches:
                        if m.startswith(self.module + "." + ".".join(self.stack[:-1])):
                            return name, m
                return name, matches[0]
            # Imported name referencing external function: record full module.symbol if known
            if name in self.imported_names:
                full = self.imported_names[name]
                return full, None  # treat as unresolved candidate with full path
            return name, None
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
                        return attr, qual
            # moduleAlias.func()
            if isinstance(func.value, ast.Name):
                mod_alias = func.value.id
                if mod_alias in self.imported_modules:
                    mod_full = self.imported_modules[mod_alias]
                    full = f"{mod_full}.{attr}"
                    return full, None
            # Fallback unresolved attribute; return final attr name
            return attr, None
        return None, None


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


def iter_py_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn.endswith('.py'):
                yield os.path.join(dirpath, fn)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description='Static Python call scanner (Stage 1)')
    ap.add_argument('--root', default='.', help='Root directory to scan')
    ap.add_argument('--out', help='Write JSON output to file')
    ap.add_argument('--max-file-size', type=int, default=1_000_000, help='Skip files larger than this (bytes)')
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    functions: List[FunctionInfo] = []
    edges: List[Edge] = []
    unresolved: List[UnresolvedCall] = []
    imported_candidates: List[Tuple[str,str]] = []  # (caller, fullExternalName)
    files_processed = 0
    skipped_size = 0
    skipped_parse = 0

    for path in iter_py_files(root):
        scanner, reason = scan_file(root, path, args.max_file_size)
        if scanner is None:
            if reason == 'size':
                skipped_size += 1
            else:
                skipped_parse += 1
            continue
        files_processed += 1
        functions.extend(scanner.functions)
        edges.extend(scanner.edges)
        unresolved.extend(scanner.unresolved)
        # Record unresolved entries that look like external references (contain a dot and not local)
        for u in scanner.unresolved:
            if '.' in u.name and not u.name.startswith(scanner.module + '.'):
                imported_candidates.append((u.caller, u.name))

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
    }

    # Second pass: external resolution for imported function calls
    func_set = {f.qualname for f in functions}
    new_edges = 0
    for caller, full in imported_candidates:
        if full in func_set:
            edges.append(Edge(caller=caller, callee=full))
            new_edges += 1
    if new_edges:
        out['edges'] = [e.__dict__ for e in edges]
        out['resolved_external'] = new_edges

    data = json.dumps(out, indent=2, sort_keys=True)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(data)
    else:
        print(data)
    # Stats line for logs
    sys.stderr.write(f"PYSCAN_STATS files={files_processed} functions={len(functions)} edges={len(edges)} unresolved={len(unresolved)}\n")
    return 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())
