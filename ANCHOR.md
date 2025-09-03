🧭 Project Anchor

Last updated: 2025-09-03 | Anchor ID: ANCHOR-1

1. Project Snapshot

Project name:
Crabviz (CLI + VS Code extension)

Goal / North Star Objective:
Provide fast, language-aware, multi-root call & dependency visualization (imports + symbol & function calls) for large polyglot codebases with clear provenance and controllable depth.

Current scope:
* TS/JS + Python file-level import graph.
* Python static function-level call extraction (intra-module simple & self calls) plus provisional cross-root edges (alias.func, from-import symbols) & higher-order partial() references.
* Module sentinel `__module__` + import edges for dependency visibility.
* Multi-root static scan merged (per-root analyzer runs combined) with prefix/suffix cross-root resolution.
* UI exports: file-level (ui style) & symbol-level (Graphviz) with depth control, import edge hiding, DOT export.
* Cleanup script (`scripts/cleanup_generated.py`) for transient artifacts.

Out of scope:
* Full Python dynamic / reflection handling.
* Precise runtime resolution (only static heuristics planned).
* Non-Python/TS languages beyond existing stubs (Go/Rust placeholders present in core Rust crate but not integrated in CLI pipeline yet).

2. Architecture & Components

Core modules:
cli.ts: Orchestrates graph build, flags, rendering (status: active, evolving).
lang-py.ts: Python import scanning + static analyzer integration & multi-root merge (status: stage 2 → transitioning to stage 3 planning).
scripts/py_callscan.py: Analyzer now emits: functions, intra-module calls, import tables, module sentinel + import edges, provisional alias/from-import/partial edges, diagnostics. (status: active Phase A)
static-py.ts: Rebuilds symbol graph + resolves provisional edges cross-root (prefix/suffix heuristics; partial-ref included). (status: evolving)
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
* Feature flags via env: CRV_DEBUG=pyscan|cross|sym (pyscan stats, cross resolution samples).
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
Analyzer: intra-module simple & self calls + alias.func + from-import + partial() provisional edges.
Module sentinel + import edges emitted.
Multi-root merging + cross-root heuristics functioning (prefix/suffix).
LSP Python call hierarchy remains sparse vs analyzer.

PENDING:
Deeper attribute chains alias.sub.func; re-export/star imports.
Provenance filtering & legend (import vs static-cross vs partial-ref vs lsp).
Confidence scoring & UI toggles.

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
2025-09-03 — Import edges + module sentinel emission added.
2025-09-03 — Provisional alias/from-import edges & relative import normalization.
2025-09-03 — partial() higher-order reference detection.
2025-09-03 — Cross-root resolver extended to partial-ref edges.
2025-09-03 — Cleanup script added.
2025-09-03 — Phase L1 root grid: --root-grid flag parsed + basic horizontal placement (rank=same representatives) implemented.

8. Open Questions

How aggressive should cross-root resolution heuristics be before risking false positives?
Do we surface unresolved_calls visually (dashed edges) or keep them hidden until confidence tagging is added?
Should Rust core be leveraged for performance-critical graph operations now or later?

9. Next Milestones

Milestone 1: Cross-root import-aware resolution (Phase A) — IN PROGRESS (basic alias/from-import/partial done; deeper attr pending).
Milestone 2: Attribute chain & alias propagation (Phase B) (ETA 2025-09-09) — alias.sub.func, re-export/star, improved relative.
Milestone 3: Confidence & provenance tagging (Phase C) (ETA 2025-09-11) — enrich edge provenance + legend + filters.
Milestone 4: Incremental cache (Phase D) (ETA 2025-09-13) — persist cross-root resolution.
Milestone 5: Unresolved diagnostics overlay (Phase E) (ETA 2025-09-15) — dashed edges / counts.
Milestone 6: Performance tuning & worker scaling benchmarks (Phase F) (ETA 2025-09-18).

Layout / Root Placement Roadmap:
* New option --root-grid CxR to arrange per-root clusters in a grid (initial focus: horizontal placement e.g. 2x1 to place two roots side-by-side).
* Future flags (not yet implemented): --root-gap-x / --root-gap-y (spacing), --root-order (name|size|input), --root-color-scheme, --root-legend.
* Phase L1 (current): --root-grid basic parsing + horizontal (single-row) arrangement. (IN PROGRESS — initial representative rank alignment implemented)
* Phase L2: full CxR grid with empty-cell alignment & optional packing.
* Phase L3: per-root styling & legend.
* Phase L4: layout persistence / stable ordering heuristics.

10. Current Mode & Parameters

Mode: agent
detail_lv: 2
code_lv: 2
Candidates / Iterations: 1 / 3
Debug: false

Cross-Root Call Resolution Plan (Detailed):

Phase A (Immediate – partial complete):
1. Import tables + relative normalization. (DONE)
2. Module sentinel + import edges. (DONE)
3. Provisional alias/from-import/partial edges. (DONE)
4. Cross-root prefix/suffix resolution including partial-ref. (DONE)
5. Remaining: deeper attribute chains, star import heuristics. (PENDING)

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
* Analyzer upgraded: import metadata, module sentinel edges, relative normalization, alias/from-import/partial provisional edges.
* Cross-root resolution (prefix/suffix) incl. partial-ref.
* File & symbol UI exports, depth control, multi-root merging, dedup, DOT export.
* Cleanup script + benchmark harness.

Pending Implementation Start: Phase A.

---
🔑 Usage

Paste this Anchor at the start of any new session with me.
Keep it updated after each major decision or change.
Treat this as the single source of truth for continuity across sessions.
