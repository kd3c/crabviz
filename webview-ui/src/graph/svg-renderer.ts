import { instance as vizInstance, Graph } from "@viz-js/viz";
import { SymbolKind } from "../lsp";

const viz = vizInstance();

export async function renderSVG(graph: Graph): Promise<SVGSVGElement> {
  let svg = await viz.then(viz => viz.renderSVGElement(graph));
  styleSVG(svg);

  return svg;
};

function styleSVG(svg: SVGSVGElement) {
  svg.querySelectorAll<SVGAElement>("a").forEach((a) => {
    let docFrag = document.createDocumentFragment();
    docFrag.append(...a.childNodes);

    let g = a.parentNode! as SVGElement;
    g.replaceChild(docFrag, a);
    g.id = g.id!.replace(/^a_/, "");

    const kind = parseInt(a.href.baseVal);
    if (isNaN(kind)) {
      g.classList.add("title");
      g.closest(".node")?.setAttribute("data-path", a.href.baseVal);

      return;
    }

    g.setAttribute("data-kind", `${kind}`);

    g.classList.add("cell", "clickable");
    switch (kind) {
      case SymbolKind.MODULE:
        g.classList.add("module");
        break;
      case SymbolKind.FUNCTION:
        g.classList.add("function");
        break;
      case SymbolKind.METHOD:
        g.classList.add("method");
        break;
      case SymbolKind.CONSTRUCTOR:
        g.classList.add("constructor");
        break;
      case SymbolKind.INTERFACE:
        g.classList.add("interface");
        break;
      case SymbolKind.FIELD:
      case SymbolKind.PROPERTY:
        g.classList.add("property");
        break;
      case SymbolKind.CLASS:
      case SymbolKind.STRUCT:
      case SymbolKind.TYPEPARAMETER:
        g.classList.add("type");
        break;
      default:
        break;
    }
  });

  svg.querySelectorAll("g.edge").forEach((edge) => {
    const [fromCell, toCell] = edge.id.split("-");

    edge.setAttribute("data-from", fromCell);
    edge.setAttribute("data-to", toCell);

    edge.querySelectorAll("path").forEach((path) => {
      let newPath = path.cloneNode() as SVGElement;
      newPath.classList.add("hover-path");
      newPath.removeAttribute("stroke-dasharray");
      path.parentNode!.appendChild(newPath);
    });
  });

  svg.querySelectorAll("g.edge").forEach(edge => {
    const [fromCell, toCell] = edge.id.split("-");

    edge.setAttribute("data-from", fromCell);
    edge.setAttribute("data-to", toCell);

    // if (this.incomings.has(toCell)) {
    //   this.incomings.get(toCell).push(edge);
    // } else {
    //   this.incomings.set(toCell, [edge]);
    // }

    // if (this.outgoings.has(fromCell)) {
    //   this.outgoings.get(fromCell).push(edge);
    // } else {
    //   this.outgoings.set(fromCell, [edge]);
    // }

    // if (this.nodeCells.has(fromNode)) {
    //   this.nodeCells.get(fromNode).add(fromCell);
    // } else {
    //   this.nodeCells.set(fromNode, new Set([fromCell]));
    // }

    // if (this.nodeCells.has(toNode)) {
    //   this.nodeCells.get(toNode).add(toCell);
    // } else {
    //   this.nodeCells.set(toNode, new Set([toCell]));
    // }

    edge.querySelectorAll("path").forEach((path) => {
      let newPath = path.cloneNode() as SVGElement;
      newPath.classList.add("hover-path");
      newPath.removeAttribute("stroke-dasharray");
      path.parentNode!.appendChild(newPath);
    });
  });

  svg.querySelectorAll("title").forEach((el) => el.remove());

  let defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = '<filter id="shadow"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-opacity="0.5"></filter>';
  svg.appendChild(defs);
}
