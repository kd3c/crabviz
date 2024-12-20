import viz from "@viz-js/viz";

import { Graph, File, Symbol, SymbolKind } from "./types";
import { escapeHtml, splitDirectory, commonAncestorPath } from "./utils";

type Node = {
  name: string;
  attributes: {
    id: string;
    label: { html: string };
  };
  dir: string;
};

type Subgraph = {
  name: string;
  nodes: Node[];
  subgraphs: Subgraph[];
  graphAttributes: {
    label: string;
  };
};

export const convert = (graph: Graph): viz.Graph => {
  const nodes = graph.files
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => file2node(f));

  const subgraph = nodes.reduce<Subgraph | undefined>((subgraph, node) => {
    if (!subgraph) {
      return {
        name: `cluster_${node.dir}`,
        nodes: [node],
        subgraphs: [],
        graphAttributes: {
          label: node.dir,
        },
      };
    }

    const ancestor = commonAncestorPath(
      subgraph.graphAttributes.label,
      node.dir
    );
    if (subgraph.graphAttributes.label.length !== ancestor.length) {
      subgraph = {
        name: `cluster_${ancestor}`,
        nodes: [],
        subgraphs: [subgraph],
        graphAttributes: {
          label: ancestor,
        },
      };
    }

    for (let it = subgraph, name = node.dir; ; ) {
      const pathLen = it.graphAttributes.label.length;
      if (name.length === pathLen) {
        subgraph.nodes.push(node);
        break;
      }

      name = name.substring(pathLen, name.length);

      for (const sg of it.subgraphs) {
        if (name.startsWith(sg.graphAttributes.label)) {
          it = sg;
          continue;
        }
      }

      it.subgraphs.push({
        name: `cluster_${name}`,
        nodes: [node],
        subgraphs: [],
        graphAttributes: {
          label: name,
        },
      });
      break;
    }

    return subgraph;
  }, undefined);

  const subgraphs = subgraph ? [subgraph] : undefined;

  const edges = graph.relations.map((r) => {
    return {
      tail: `${r.from.file_id}`,
      head: `${r.to.file_id}`,
      attributes: {
        id: `${r.from.file_id}:${r.from.line}_${r.from.character}-${r.to.file_id}:${r.to.line}_${r.to.character}`,
        tailport: `${r.from.line}_${r.from.character}`,
        headport: `${r.to.line}_${r.to.character}`,
      },
    };
  });

  const graphAttributes = {
    rankdir: "LR",
    ranksep: 2.0,
    fontname: "Arial",
  };

  const nodeAttributes = {
    fontsize: "16",
    fontname: "Arial",
    shape: "plaintext",
    style: "rounded, filled",
  };

  const edgeAttributes = {
    label: " ",
  };

  return {
    graphAttributes,
    nodeAttributes,
    edgeAttributes,
    edges,
    subgraphs,
  };
};

const file2node = (file: File): Node => {
  const [dir, name] = splitDirectory(file.path);
  const id = file.id.toString();
  return {
    name: id,
    attributes: {
      id: id,
      label: {
        html: `
          <TABLE BORDER="0" CELLBORDER="1" CELLSPACING="8" CELLPADDING="4">
            <TR><TD HREF="${file.path}" WIDTH="230" BORDER="0" CELLPADDING="6">
            ${name}
            </TD></TR>
            ${file.symbols.map((s) => symbol2cell(file.id, s)).join("\n")}
            <TR><TD CELLSPACING="0" HEIGHT="1" WIDTH="1" FIXEDSIZE="TRUE" STYLE="invis"></TD></TR>
          </TABLE>
        `,
      },
    },
    dir,
  };
};

const symbol2cell = (fileId: number, symbol: Symbol): string => {
  const text = escapeHtml(symbol.name);
  const port = `${symbol.range.start.line}_${symbol.range.start.character}`;
  const href = `HREF="${symbol.kind}"`;
  const styles =
    symbol.kind in
    [
      SymbolKind.Class,
      SymbolKind.Enum,
      SymbolKind.Field,
      SymbolKind.Property,
      SymbolKind.Struct,
    ]
      ? ""
      : 'STYLE="ROUNDED"';

  if (symbol.children.length <= 0) {
    return `<TR><TD PORT="${port}" ID="${fileId}:${port}" ${href} ${styles}>${text}</TD></TR>`;
  }

  return `
    <TR><TD BORDER="0" CELLPADDING="0">
    <TABLE ID="${fileId}:${port}" ${href} ${styles} CELLSPACING="8" CELLPADDING="4" CELLBORDER="1" BGCOLOR="green">
    <TR><TD PORT="${port}" BORDER="0">${text}</TD></TR>
    ${symbol.children.map((s) => symbol2cell(fileId, s)).join("\n")}
    </TABLE>
    </TD></TR>
  `;
};
