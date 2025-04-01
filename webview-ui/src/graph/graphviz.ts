import viz from "@viz-js/viz";

import { Graph, File, Symbol, SymbolKind } from "./types";
import { escapeHtml, splitDirectory, commonAncestorPath } from "./utils";

type Node = {
  name: string;
  attributes: Attributes;
  dir: string;
};

type Subgraph = {
  nodes: Node[];
  subgraphs: Subgraph[];
  graphAttributes: Attributes;
  dir: string;
};

interface Attributes {
  [name: string]: string | number | boolean | { html: string };
}

export const convert = (graph: Graph): viz.Graph => {
  const nodes = graph.files
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => file2node(f));

  const subgraph = nodes.reduce<Subgraph | undefined>((subgraph, node) => {
    if (!subgraph) {
      return createSubgraph(node.dir, node);
    }

    // find the common ancester path
    const ancestor = commonAncestorPath(subgraph.dir, node.dir);
    if (subgraph.dir.length !== ancestor.length) {
      subgraph = createSubgraph(ancestor, undefined, subgraph);
    }

    // find the parent path or create it
    for (let it = subgraph, name = node.dir; ; ) {
      const pathLen = it.dir.length;
      if (name.length === pathLen) {
        subgraph.nodes.push(node);
        break;
      }

      name = name.substring(pathLen + 1, name.length);

      for (const sg of it.subgraphs) {
        if (name.startsWith(sg.dir)) {
          it = sg;
          continue;
        }
      }

      it.subgraphs.push(createSubgraph(name, node));
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
    fontsize: "16",
    fontname: "Arial",
    label: "",
  };

  const nodeAttributes = {
    fontsize: "16",
    fontname: "Arial",
    shape: "plaintext",
    style: "filled",
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

const createSubgraph = (
  dir: string,
  node?: Node,
  subgraph?: Subgraph
): Subgraph => {
  const nodes = [];
  if (node) {
    nodes.push(node);
  }

  return {
    nodes,
    subgraphs: subgraph ? [subgraph] : [],
    graphAttributes: {
      label: {
        html: `<TABLE BORDER="0" BGCOLOR="lightgray" CELLSPACING="4" CELLBORDER="0"><TR><TD>${dir}</TD></TR></TABLE>`,
      },
      cluster: true,
    },
    dir,
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
          <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4">
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

  let icon = "";
  switch (symbol.kind) {
    case SymbolKind.Class:
      icon = "C";
      break;
    case SymbolKind.Struct:
      icon = "S";
      break;
    case SymbolKind.TypeParameter:
      icon = "T";
      break;
    case SymbolKind.Field:
      icon = "f";
      break;
    case SymbolKind.Property:
      icon = "p";
      break;
    default:
      break;
  }
  if (icon.length > 0) {
    icon = `<B>${icon}</B>  `;
  }

  if (symbol.children.length <= 0) {
    return `<TR><TD PORT="${port}" ID="${fileId}:${port}" ${href} BGCOLOR="blue">${icon}${text}</TD></TR>`;
  }

  return `
    <TR><TD CELLPADDING="0">
    <TABLE ID="${fileId}:${port}" ${href} BORDER="0" CELLSPACING="8" CELLPADDING="4" CELLBORDER="0" BGCOLOR="green">
    <TR><TD PORT="${port}">${icon}${text}</TD></TR>
    ${symbol.children.map((s) => symbol2cell(fileId, s)).join("\n")}
    </TABLE>
    </TD></TR>
  `;
};
