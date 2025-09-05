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
* `--symbol-depth N` – symbol-level depth control for detailed graphs.
* `--ui-file` – produce a file-level interactive HTML (extension-like look).
* `--rankdir LR|TB` – layout direction (Left-to-Right or Top-to-Bottom).
* `--symbol-layout table|split` – choose between table layout or split layout for symbols.
* `--show-internal-file-calls` – include internal calls within files in the graph.

### Example Command

To generate an interactive HTML graph with specific depth and layout:

```
$rootA='path/to/rootA'; $rootB='path/to/rootB'; $out='path/to/output.html';
node dist/cli.js --roots "$rootA" "$rootB" --out "$out" --renderer export --format html --ui-file --call-depth 2 --symbol-depth 3 --rankdir TB --symbol-layout table --show-internal-file-calls
```

### Python Engine Selection

```
# Static analyzer (default)
crabviz --roots myproj --out out.html --python-engine static

# Force legacy LSP behavior (pyright)
crabviz --roots myproj --out out.html --python-engine lsp
```

Set `CRV_DEBUG=py` to see analyzer/log debugging details.

### Roadmap Stages

1. Static Python import + intra-file call capture (done)
2. Integrate static call edges into symbol graph (in progress)
3. Cross-module call resolution & provenance tagging
4. Performance tuning & large project resilience

Limitations (current): Python function-to-function edges are partial; imported targets unresolved until Stage 3.

### Additional CLI Flags

The following additional flags are available for advanced usage:

* `--impl` – Include interface implementation edges (default: true).
* `--trim-last-depth` – Trim the deepest collected call depth (one level before leaves) (default: false).
* `--quiet` – Suppress log/debug output (default: false).
* `--files-per-row N` – When `--rankdir=TB`, pack up to N file nodes per horizontal row within a folder (default: 0).
* `--root-grid CxR` – Arrange roots in a grid (e.g., `2x1` for 2 columns and 1 row) (default: undefined).
* `--hide-imports` – Hide import edges (show only call edges) (default: false).
* `--dot-out path/to/file.dot` – Write raw DOT graph to a specified file (useful for debugging).

These flags provide additional control over the graph generation process and are useful for debugging or customizing the output.

## Credits

Crabviz is inspired by [graphql-voyager](https://github.com/graphql-kit/graphql-voyager) and [go-callvis](https://github.com/ondrajz/go-callvis).
