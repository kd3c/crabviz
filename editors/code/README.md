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

## Requirements

Since Crabviz utilizes the capabilities of language servers under the hood, if you want to analyze source code with it, you should have corresponding language extensions installed.

## Usage

* Generate a call graph for selected files and folders

    ![call graph for files](https://raw.githubusercontent.com/chanhx/assets/a62015f1ee792dd57d756f106a9e48815f106ee3/crabviz/code/call_graph_for_selected_files.gif)

    Select the files and folders (support multiple selections) you want to analyze, right click and select `Crabviz: Generate Call Graph` in the context menu. If you want to analyze the whole project, don't select any files, right click on blank space.

* Generate a call graph for a selected function

    ![call graph for a selected function](https://raw.githubusercontent.com/chanhx/assets/a62015f1ee792dd57d756f106a9e48815f106ee3/crabviz/code/call_graph_for_a_selected_function.gif)

    Right click on the function you want to analyze, and select `Crabviz: Generate Function Call Graph` in the context menu.
