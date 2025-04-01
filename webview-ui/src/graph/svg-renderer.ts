import { instance as vizInstance, Graph } from "@viz-js/viz";
import { SymbolKind } from "../lsp";

const viz = vizInstance();

const namespaceURI = "http://www.w3.org/2000/svg";

export async function renderSVG(graph: Graph): Promise<SVGSVGElement> {
  const svg = await viz.then((viz) => viz.renderSVGElement(graph));
  styleSVG(svg);

  return svg;
}

function styleSVG(svg: SVGSVGElement) {
  svg.querySelectorAll("title").forEach((el) => el.remove());

  svg.querySelectorAll<SVGAElement>("a").forEach((a) => {
    const docFrag = document.createDocumentFragment();
    docFrag.append(...a.childNodes);

    const g = a.parentNode! as SVGElement;
    g.replaceChild(docFrag, a);
    g.id = g.id!.replace(/^a_/, "");

    const kind = parseInt(a.href.baseVal);
    if (isNaN(kind)) {
      g.classList.add("title");
      g.closest(".node")?.setAttribute("data-path", a.href.baseVal);

      return;
    }

    g.setAttribute("data-kind", `${kind}`);
    g.classList.add("cell");

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

  svg
    .querySelectorAll<SVGPolygonElement>(":is(g.node polygon, g.cluster polygon:not(:first-of-type))")
    .forEach((polygon) => {
      const p0 = polygon.points[0];
      const p2 = polygon.points[2];
      const rect = document.createElementNS(namespaceURI, "rect");
      rect.setAttribute("x", Math.min(p0.x, p2.x).toString());
      rect.setAttribute("y", Math.min(p0.y, p2.y).toString());
      rect.setAttribute("width", Math.abs(p0.x - p2.x).toString());
      rect.setAttribute("height", Math.abs(p0.y - p2.y).toString());

      const g = polygon.parentNode! as SVGElement;
      g.replaceChild(rect, polygon);
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

  const defs = document.createElementNS(namespaceURI, "defs");
  defs.innerHTML =
    '<filter id="shadow"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-opacity="0.5"></filter>';
  svg.appendChild(defs);
}
