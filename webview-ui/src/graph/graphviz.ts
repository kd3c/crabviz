import { Graph as VizGraph } from "@viz-js/viz";

import { Graph, File, Symbol, Relation, RelationKind } from "./types";
import { SymbolKind } from "../lsp";
import { escapeHtml, splitDirectory, commonAncestorPath } from "./utils";

type Node = {
  name: string;
  attributes: Attributes;
  dir: string;
};

type Subgraph = {
  name: string;
  nodes: Node[];
  subgraphs: Subgraph[];
  graphAttributes: Attributes;
  dir: string;
};

type Edge = {
  tail: string;
  head: string;
  attributes: Attributes;
};

interface Attributes {
  [name: string]: string | number | boolean | { html: string };
}

export const convert = (graph: Graph, collapse: boolean): VizGraph => {
  const nodes = graph.files
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => file2node(f, collapse));

  const subgraph = nodes.reduce<Subgraph | undefined>((subgraph, node) => {
    if (!subgraph) {
      const sg = createSubgraph(node.dir);
      sg.nodes.push(node);
      return sg;
    }

    // find the common ancester path
    const ancestor = commonAncestorPath(subgraph.dir, node.dir);
    if (subgraph.dir.length != ancestor.length) {
      subgraph = createSubgraph(ancestor, subgraph);
    }

    // find the parent path or create it
    findAncester: for (let it = subgraph, dir = node.dir; ; ) {
      if (dir == it.dir) {
        it.nodes.push(node);
        break;
      }

      dir = dir.substring(it.dir.length + 1);

      for (const sg of it.subgraphs) {
        if (dir.startsWith(sg.dir)) {
          it = sg;
          continue findAncester;
        }
      }

      const sg = createSubgraph(dir);
      sg.nodes.push(node);
      it.subgraphs.push(sg);
      break;
    }

    return subgraph;
  }, undefined);

  return {
    graphAttributes: {
      rankdir: "LR",
      ranksep: 2.0,
      fontsize: "16",
      fontname: "Arial",
      label: "",
    },
    nodeAttributes: {
      fontsize: "16",
      fontname: "Arial",
      shape: "plaintext",
      style: "filled",
    },
    edgeAttributes: {
      arrowsize: "1.5",
      label: " ",
    },
    subgraphs: subgraph ? [subgraph] : [],
    edges: collectEdges(graph.relations, collapse),
  };
};

const createSubgraph = (function () {
  let count = 0;

  return (dir: string, subgraph?: Subgraph): Subgraph => {
    if (subgraph) {
      subgraph.dir = subgraph.dir.substring(dir.length + 1);
      subgraph.graphAttributes.label = {
        html: subgraphTitle(subgraph.dir),
      };
    }

    count += 1;

    return {
      name: `cluster_${count}`,
      nodes: [],
      subgraphs: subgraph ? [subgraph] : [],
      graphAttributes: {
        label: {
          html: subgraphTitle(dir),
        },
        // `cluster = true` doesn't work as expected, so I have to name the subgraph `cluster_xxx`
        // cluster: true,
      },
      dir,
    };
  };
})();

const subgraphTitle = (title: string): string => {
  return `<TABLE BORDER="0" BGCOLOR="lightgray" CELLPADDING="6" CELLBORDER="0"><TR><TD>${title}</TD></TR></TABLE>`;
};

const file2node = (file: File, collapsed: boolean = false): Node => {
  const [dir, name] = splitDirectory(file.path);
  const id = file.id.toString();

  return {
    name: id,
    attributes: {
      id,
      label: {
        html: collapsed || file.symbols.length <= 0
          ? `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="8" CELLPADDING="4">
            <TR><TD HREF="${file.path}" WIDTH="200" BORDER="0" CELLPADDING="6">
            ${name}
            </TD></TR>
          </TABLE>`
          : `
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
    case SymbolKind.CLASS:
      icon = "C";
      break;
    case SymbolKind.STRUCT:
      icon = "S";
      break;
    case SymbolKind.ENUM:
      icon = "E";
      break;
    case SymbolKind.TYPE_PARAMETER:
      icon = "T";
      break;
    case SymbolKind.FIELD:
      icon = "f";
      break;
    case SymbolKind.PROPERTY:
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

export const collectEdges = (
  relations: Relation[],
  collapse: boolean
): Edge[] => {
  if (!collapse) {
    return relations.map((r) => ({
      tail: `${r.from.fileId}`,
      head: `${r.to.fileId}`,
      attributes: {
        id: `${r.from.fileId}:${r.from.line}_${r.from.character}-${r.to.fileId}:${r.to.line}_${r.to.character}`,
        tailport: `${r.from.line}_${r.from.character}`,
        headport: `${r.to.line}_${r.to.character}`,
        class: r.kind == RelationKind.Impl ? "impl" : "",
      },
    }));
  }

  const edges = new Map<string, Edge>();
  relations.forEach((r) => {
    const tail = r.from.fileId.toString();
    const head = r.to.fileId.toString();

    const cls = r.kind == RelationKind.Impl ? "impl" : "";
    const id = `${tail}:${cls}-${head}:`;
    if (!edges.get(id)) {
      edges.set(id, {
        tail,
        head,
        attributes: {
          id,
          class: cls,
        },
      });
    }
  });

  return Array.from(edges.values());
};
