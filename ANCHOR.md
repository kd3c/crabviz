🧭 Project Anchor

Last updated: 2025-09-02 | Anchor ID: ANCHOR-1

1. Project Snapshot

Project name:
Crabviz (CLI + VS Code extension)

Goal / North Star Objective:
Provide fast, language-aware, multi-root call & dependency visualization (imports + symbol & function calls) for large polyglot codebases with clear provenance and controllable depth.

Current scope:
* TS/JS + Python file-level import graph.
* Python static function-level call extraction (intra-module simple & self calls) collapsed to file-level or shown symbol-level in UI export.
* Multi-root static scan merged (per-root analyzer runs combined).
* UI export (file & symbol) with depth control, import edge hiding, DOT export.

Out of scope:
* Full Python dynamic / reflection handling.
* Precise runtime resolution (only static heuristics planned).
* Non-Python/TS languages beyond existing stubs (Go/Rust placeholders present in core Rust crate but not integrated in CLI pipeline yet).

2. Architecture & Components

Core modules:
cli.ts: Orchestrates graph build, flags, rendering (status: active, evolving).
lang-py.ts: Python import scanning + static analyzer integration & multi-root merge (status: stage 2 → transitioning to stage 3 planning).
scripts/py_callscan.py: Stage 1 static analyzer (intra-module functions & calls) (status: stable baseline).
static-py.ts: Reconstruct symbol graph from analyzer JSON (status: added dedupe; will expand for provenance & cross-root edges).
ui-symbol-graph.ts: LSP-based symbol graph + call hierarchy (TS/Py via LSP when available) (status: operative; limited Python due to LSP gaps).
ui-file-graph.ts & export-html.ts: Visualization (status: stable; candidate for legend & provenance overlays).
graph.ts: DOT emitter & styling (status: stable; will gain provenance styling classes).
bench-py.ts: Performance harness for analyzer workers (status: initial; optional).

Tech stack:
Languages: TypeScript (CLI & UI builder), Python (static analysis script), Rust (core/lib foundation not yet wired into CLI), HTML/SVG/CSS (render output).
Frameworks: LSP protocol clients (pyright, typescript-language-server), Graphviz via @viz-js/viz.
Databases: None (JSON cache planned).
Infrastructure: Local execution; no external services.

3. Conventions & Standards

Naming conventions:
Python → snake_case
Node.js → camelCase
Files/folders → kebab-case (CLI) or existing repo style preserved.

Formatting:
* TypeScript: tsc + existing style (no enforced formatter yet).
* Python: Minimal; keep analyzer readable (future: black optional).

Logging:
* Feature flags via env: CRV_DEBUG=py|sym, etc.
* Console stderr for progress; quiet flag suppresses.

Testing:
* Manual CLI invocations + test-data sample Python packages.
* Future: add Jest tests for graph shaping & Python JSON fixture validation.

4. Invariants (Must Always Hold True)

* No new external libraries without explicit approval.
* Respect file paths and naming from repo.
* No fabricated APIs, endpoints, or configs.
* Security baseline: no arbitrary code execution beyond controlled analyzer; no network calls unless LSP; sanitize file paths in output; avoid leaking env variables.

5. Rubric & Evaluation Weights
Dimension	Weight	Notes
Correctness	0.35	Must compile/run
Alignment	0.25	Fit repo, naming, arch
Clarity	0.10	Clean + minimal
Maintainability	0.15	Modular, testable
Performance	0.08	Efficient
Safety	0.05	Error handling, auth
Cost	0.02	Avoid bloat

6. Assumption Ledger

VERIFIED:
Static analyzer Stage 1 resolves only intra-module simple & self calls → confirmed via py_callscan.py code.
Multi-root call edges previously missing because analyzer ran only once → confirmed by change & increased edge count.
LSP Python call hierarchy insufficient for deep coverage → observed earlier (few or no edges from pyright).

PENDING:
Cross-root calls largely appear via imported alias/attribute patterns; we assume moderate alias variety (needs confirmation with larger samples).
Users need provenance filtering (import vs static-py vs lsp) → not yet confirmed by users.

REMOVED:
Assumption that single-root scanning acceptable → superseded by multi-root requirement.
Assumption that file-level only depth control sufficient → symbol-level depth needed & implemented.

7. Decisions Log

2025-08-xx — Adopt static Python analyzer to replace weak LSP call hierarchy for Python.
2025-08-xx — Introduce --call-depth replacing deprecated --max-depth.
2025-08-xx — Add --hide-imports & DOT export for debugging.
2025-09-02 — Multi-root static analysis merging implemented.
2025-09-02 — Symbol-level relation dedup for static analyzer output added.
2025-09-02 — Depth control applied to simplified UI export.

8. Open Questions

How aggressive should cross-root resolution heuristics be before risking false positives?
Do we surface unresolved_calls visually (dashed edges) or keep them hidden until confidence tagging is added?
Should Rust core be leveraged for performance-critical graph operations now or later?

9. Next Milestones

Milestone 1: Cross-root import-aware resolution (Phase A) (ETA 2025-09-05, owner: CLI) — map imports & from-import names to modules; resolve calls to imported names & attribute calls on imported module aliases (simple attr).
Milestone 2: Attribute chain & alias propagation (Phase B) (ETA 2025-09-09) — handle module.sub.func, re-exported names, relative imports.
Milestone 3: Confidence & provenance tagging (Phase C) (ETA 2025-09-11) — edge provenance (static-intra, static-cross, lsp, import) + optional legend & filters.
Milestone 4: Incremental cache (Phase D) (ETA 2025-09-13) — per-file hash cache storing resolved cross-root edges & invalidation.
Milestone 5: Unresolved diagnostics overlay (Phase E) (ETA 2025-09-15) — dashed edges or sidebar counts, toggleable.
Milestone 6: Performance tuning & worker scaling benchmarks (Phase F) (ETA 2025-09-18) — auto worker count, profiling large roots.

10. Current Mode & Parameters

Mode: agent
detail_lv: 2
code_lv: 2
Candidates / Iterations: 1 / 3
Debug: false

Cross-Root Call Resolution Plan (Detailed):

Phase A (Immediate):
1. Extend analyzer to emit import table per module: aliases (import x as a), from-import symbols, relative imports resolved to module path.
2. Build global module->file map (already partially present) across all roots.
3. Build index: symbol simple name -> list of qualified functions (limit by exported module if from-import used).
4. During call collection, for each unresolved simple name in a module:
   * If name in from-import set: direct map to imported module symbol (module.name) → add cross-file edge.
   * If call is Attribute (alias.func()) where alias is imported module alias: map to module.func if present.
5. Tag new edges provenance=static-cross; record resolution mode for confidence scoring.

Phase B:
1. Handle nested attributes: alias.sub.func (resolve alias.sub as submodule path if directory present).
2. Relative import resolution for from .pkg import name (already partially handled in import scanner; integrate into symbol mapping for cross-root linking).
3. Basic re-export detection: if module's __all__ present (optional future) or star-import fallback.

Phase C:
1. Confidence scoring: direct import match (high), alias attribute (medium), heuristic name match (low).
2. Add CLI filters: --edge-provenance include list; legend in HTML.

Phase D:
1. Introduce cache file (.crabviz-pycache.json) storing per-file: hash + resolved functions + edges + import table.
2. On run, skip parsing & re-resolution for unchanged files; only re-link edges referencing changed imports.

Phase E:
1. Optionally emit unresolved edges as dashed gray when --show-unresolved.
2. Provide per-file unresolved summary to aid heuristic tuning.

Phase F:
1. Optimize traversal & resolution loops; parallelize with ThreadPoolExecutor for resolution pass.
2. Provide metrics JSON (counts, time per phase).

Risk Mitigation:
* Begin with precise only (import-backed) matches to avoid false edges.
* Keep heuristic-only matches disabled unless --allow-heuristic specified.
* Provenance & confidence allow UI filtering if noise arises.

Done So Far (Recap):
* Stage 1 analyzer, import scanning, static intra-module calls.
* File & symbol UI exports, depth control, multi-root merging, dedup, DOT export.
* Benchmark harness & multi-root improvements.

Pending Implementation Start: Phase A.

---
🔑 Usage

Paste this Anchor at the start of any new session with me.
Keep it updated after each major decision or change.
Treat this as the single source of truth for continuity across sessions.
