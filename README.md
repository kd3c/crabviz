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

## Credits

Crabviz is inspired by [graphql-voyager](https://github.com/graphql-kit/graphql-voyager) and [go-callvis](https://github.com/ondrajz/go-callvis).
