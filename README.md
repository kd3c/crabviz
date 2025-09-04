# Crabviz

Crabviz is a [LSP](https://microsoft.github.io/language-server-protocol/)-based call graph generator. It leverages the Language Server Protocol to generate interactive call graphs, helps you visually explore source code.

## Features

* Workable for various programming languages
* Highlight on click
* Two kinds of graphs

   You can generate a call graph for selected files to get an overview, or for a selected function to track the call hierarchy.
* Collapse Files to view file relationships
* Save call graphs as HTML or SVG
* Go to definition
* Search symbols

## Preview

![preview](https://raw.githubusercontent.com/chanhx/assets/a62015f1ee792dd57d756f106a9e48815f106ee3/crabviz/preview.gif)

## Install

Since Crabviz utilizes the capabilities of language servers, it is better suited as an IDE/editor extension than a standalone command line tool.

It is currently available on [VS Code](https://marketplace.visualstudio.com/items?itemName=chanhx.crabviz), and PRs for other editors are welcome.

## CLI (experimental)

The repository contains an experimental CLI (`@crabviz/cli`) that can emit DOT/HTML/SVG graphs and a simplified interactive export similar to the VS Code extension.

Basic usage:

```
crabviz --roots path/to/project --out graph.html --renderer export --format html
```

Key flags:

* `--call-depth N` – call hierarchy depth (0=file-level only, 1=direct calls, 2+=multi-hop)
* `--ui-file` – produce a file-level interactive HTML (extension-like look)
* `--python-engine auto|static|lsp` – choose Python analysis backend. `static` (default via `auto`) uses an internal AST scanner for imports (and soon call edges). `lsp` forces pyright (limited call hierarchy for Python).
* `--rankdir LR|TB` plus `--files-per-row N` – layout controls for UI export

Python engine selection:

```
# Static analyzer (default)
crabviz --roots myproj --out out.html --python-engine static

# Force legacy LSP behavior (pyright)
crabviz --roots myproj --out out.html --python-engine lsp
```

Set `CRV_DEBUG=py` to see analyzer/log debugging details.

Roadmap stages:
1. Static Python import + intra-file call capture (done)
2. Integrate static call edges into symbol graph (in progress)
3. Cross-module call resolution & provenance tagging
4. Performance tuning & large project resilience

Limitations (current): Python function-to-function edges are partial; imported targets unresolved until Stage 3.

## Credits

Crabviz is inspired by [graphql-voyager](https://github.com/graphql-kit/graphql-voyager) and [go-callvis](https://github.com/ondrajz/go-callvis).
