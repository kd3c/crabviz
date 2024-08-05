/**
 * Apply function to each selected child
 *
 * @param {Element} parent
 * @param {string} selectors
 * @param {Function} fn
 */
const forEachSelectedChild = (parent, selectors, fn) => {
  parent.querySelectorAll(selectors).forEach(fn);
};

/**
 * @enum { number }
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const GraphElemType = Object.freeze({
  NODE: 0,
  CELL: 1,
  EDGE: 2,
});

/**
 * @enum { number }
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const SymbolKind = Object.freeze({
    FILE: 1,
    MODULE: 2,
    NAMESPACE: 3,
    PACKAGE: 4,
    CLASS: 5,
    METHOD: 6,
    PROPERTY: 7,
    FIELD: 8,
    CONSTRUCTOR: 9,
    ENUM: 10,
    INTERFACE: 11,
    FUNCTION: 12,
    VARIABLE: 13,
    CONSTANT: 14,
    STRING: 15,
    NUMBER: 16,
    BOOLEAN: 17,
    ARRAY: 18,
    OBJECT: 19,
    KEY: 20,
    NULL: 21,
    ENUMMEMBER: 22,
    STRUCT: 23,
    EVENT: 24,
    OPERATOR: 25,
    TYPEPARAMETER: 26,
});

/**
 * @enum { string }
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const CssClass = Object.freeze({
  TITLE: 'title',
  CELL: 'cell',
  CLICKABLE: 'clickable',
  CONSTRUCTOR: 'constructor',
  FUNCTION: 'function',
  INTERFACE: 'interface',
  METHOD: 'method',
  MODULE: 'module',
  PROPERTY: 'property',
  TYPE: 'type',
});

class CallGraph {
  /**
   * the SVG element
   *
   * @type {SVGSVGElement}
   */
  svg;

  /**
   * toggle fading edges
   *
   * @type {HTMLStyleElement}
   */
  edgesFadingStyle;

  /** @type {boolean} */
  focusMode;

  /**
   * focus element id
   *
   * @type {?string}
   */
  focus;

  /**
   * edges group by start cells' id
   *
   * @type {Map<string, SVGGElement[]>}
   */
  incomings;

  /**
   * edges group by end cells' id
   *
   * @type {Map<string, SVGGElement[]>}
   */
  outgoings;

  /**
   * cells' id group by nodes' id
   *
   * @type {Map<string, Set<string>>}
   */
  nodeCells;

  /** @type {Set<SVGGElement>[]} */
  selectedElems;

  /**
   * @constructor
   * @param {SVGSVGElement} svg
   * @param {boolean} focusMode
   */
  constructor(svg, focusMode) {
    this.svg = svg;
    this.edgesFadingStyle = document.getElementById("edges-fading");
    this.edgesFadingStyle.disabled = true;

    this.focusMode = focusMode;
    this.incomings = new Map();
    this.outgoings = new Map();
    this.nodeCells = new Map();
    this.selectedElems = Object.seal(new Array(new Set(), new Set(), new Set()));
  }

  activate() {
    this.processSVG();
    this.addListeners();
  }

  processSVG() {
    forEachSelectedChild(this.svg, "a", (a) => {
      let docFrag = document.createDocumentFragment();
      docFrag.append(...a.childNodes);

      let g = a.parentNode;
      g.replaceChild(docFrag, a);
      g.id = g.id.replace(/^a_/, "");

      const kind = parseInt(a.href.baseVal);
      if (isNaN(kind)) { // title
        g.classList.add(CssClass.TITLE);

        const [path, id] = a.href.baseVal.split(';');
        g.setAttribute("data-path", path);
        g.setAttribute("data-file_id", id);

        return;
      }

      g.setAttribute("data-kind", kind);

      g.classList.add(CssClass.CELL);
      switch (kind) {
        case SymbolKind.MODULE:
          g.classList.add(CssClass.MODULE);
          break;
        case SymbolKind.FUNCTION:
          g.classList.add(CssClass.FUNCTION, CssClass.CLICKABLE);
          break;
        case SymbolKind.METHOD:
          g.classList.add(CssClass.METHOD, CssClass.CLICKABLE);
          break;
        case SymbolKind.CONSTRUCTOR:
          g.classList.add(CssClass.CONSTRUCTOR, CssClass.CLICKABLE);
          break;
        case SymbolKind.INTERFACE:
          g.classList.add(CssClass.INTERFACE, CssClass.CLICKABLE);
          break;
        case SymbolKind.FIELD:
        case SymbolKind.PROPERTY:
          g.classList.add(CssClass.PROPERTY);
          break;
        case SymbolKind.CLASS:
        case SymbolKind.STRUCT:
        case SymbolKind.TYPEPARAMETER:
          g.classList.add(CssClass.TYPE);
          break;
        default:
          break;
      }
    });


    this.svg.querySelectorAll("g.edge").forEach(edge => {
      const [fromNode, fromCell, toNode, toCell] = edge.id.split("-");

      edge.setAttribute("data-from", fromCell);
      edge.setAttribute("data-to", toCell);

      if (this.incomings.has(toCell)) {
        this.incomings.get(toCell).push(edge);
      } else {
        this.incomings.set(toCell, [edge]);
      }

      if (this.outgoings.has(fromCell)) {
        this.outgoings.get(fromCell).push(edge);
      } else {
        this.outgoings.set(fromCell, [edge]);
      }

      if (this.nodeCells.has(fromNode)) {
        this.nodeCells.get(fromNode).add(fromCell);
      } else {
        this.nodeCells.set(fromNode, new Set([fromCell]));
      }

      if (this.nodeCells.has(toNode)) {
        this.nodeCells.get(toNode).add(toCell);
      } else {
        this.nodeCells.set(toNode, new Set([toCell]));
      }

      forEachSelectedChild(edge, "path", (path) => {
        let newPath = path.cloneNode();
        newPath.classList.add("hover-path");
        newPath.removeAttribute("stroke-dasharray");
        path.parentNode.appendChild(newPath);
      });
    });


    if (this.focusMode) {
      this.focus = this.svg.querySelector(".highlight").id;
    }


    forEachSelectedChild(this.svg, "title", (el) => el.remove());


    let defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = '<filter id="shadow"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-opacity="0.5"></filter>';
    this.svg.appendChild(defs);
  }

  addListeners() {
    const delta = 6;
    let startX = 0;
    let startY = 0;

    this.svg.addEventListener('mousedown', (event) => {
      startX = event.pageX;
      startY = event.pageY;
    });

    this.svg.addEventListener("mouseup", (event) => {
      const diffX = Math.abs(event.pageX - startX);
      const diffY = Math.abs(event.pageY - startY);

      if (diffX > delta || diffY > delta) {
        // a mouse drag event
        return;
      }

      this.reset();

      const target = event.target;
      const elemTuple = this.findClosestGraphElem(target);

      if (elemTuple === null) {
        return;
      }

      const [elem, elemType] = elemTuple;

      switch (elemType) {
        case GraphElemType.NODE:
          this.onSelectNode(elem);
          break;
        case GraphElemType.CELL:
          this.onSelectCell(elem);
          break;
        case GraphElemType.EDGE:
          this.onSelectEdge(elem);
          break;
      }
    });
  }

  /**
   * Deselect all elements
   */
  reset() {
    this.selectedElems.forEach(s => {
      s.forEach(g => g.classList.remove("selected", "incoming", "outgoing"));
      s.clear();
    });

    this.edgesFadingStyle.disabled = true;
  };

  /**
   * @param {SVGGElement} edge
   */
  onSelectEdge(edge) {
    this.highlightEdge(edge, "selected");
    this.edgesFadingStyle.disabled = false;
  };

  /**
   * @param {SVGGElement} cell
   */
  onSelectCell(cell) {
    if (!cell.classList.contains("clickable")) {
      return;
    }

    cell.classList.add("selected");
    this.selectedElems[GraphElemType.CELL].add(cell);

    if (this.focus) {
      this.highlightEdgeInFocusMode(cell.id);
    } else {
      (this.incomings.get(cell.id) ?? []).forEach(edge => {
        this.highlightEdge(edge, "incoming");
      });

      (this.outgoings.get(cell.id) ?? []).forEach(edge => {
        this.highlightEdge(edge, "outgoing");
      });
    }

    this.edgesFadingStyle.disabled = false;

    window.dispatchEvent(new MessageEvent("message", {
      data: {
        command: "select symbol",
        id: cell.id,
        symbol: cell.querySelector(":scope > text:last-of-type")?.textContent,
      }
    }));
  };

  /**
   * @param {SVGGElement} node
   */
  onSelectNode(node) {
    this.selectedElems[GraphElemType.NODE].add(node);

    const cells = this.nodeCells.get(node.id);
    if (cells) {
      const cids = Array.from(cells);

      cids
        .flatMap(cid => this.incomings.get(cid) ?? [])
        .forEach(edge => {
          this.highlightEdge(edge, "incoming");
        });

      cids
        .flatMap(cid => this.outgoings.get(cid) ?? [])
        .forEach(edge => {
          this.highlightEdge(edge, "outgoing");
        });
    }

    this.edgesFadingStyle.disabled = false;

    node.classList.add("selected");

    const titleG = node.querySelector("g.title");
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        command: "select symbol",
        id: node.id,
        symbol: titleG.firstElementChild.textContent,
      }
    }));
  }

  /**
   * @param {SVGGElement} edge
   * @param {string} cls
   */
  highlightEdge(edge, cls) {
    edge.classList.add(cls);
    this.selectedElems[GraphElemType.EDGE].add(edge);
  }

  /**
   * @param {SVGGElement} elem
   * @returns {SVGGElement}
   */
  findClosestGraphElem(elem) {
    const closetElem = elem.closest("g:is(.node, .cell, .edge)");
    if (!closetElem) {
      return null;
    }

    for (const cls of closetElem.classList) {
      if (cls === "node") {
        return [closetElem, GraphElemType.NODE];
      } else if (cls === "cell") {
        return [closetElem, GraphElemType.CELL];
      } else if (cls === "edge") {
        return [closetElem, GraphElemType.EDGE];
      }
    }

    return null;
  }

  // TODO: fix highlight color problem in recursive calls
  // consider a recursive call like this:
  // a -> b -> c -> a
  // focus: a
  // at present, when b or c is selected, the edges are not highlighted in right color to show that they are in recursion.

  /**
   * @param {string} cellId
   */
  highlightEdgeInFocusMode(cellId) {
    let iVisited = new Set([cellId, this.focus]);
    let oVisited = new Set([cellId, this.focus]);

    let newIncomings = this.incomings.get(cellId) ?? [];
    let newOutgoings = this.outgoings.get(cellId) ?? [];

    while (newIncomings.length > 0) {
      newIncomings = newIncomings
        .flatMap(e => {
          this.highlightEdge(e, "incoming");

          let id = e.dataset.from;
          if (iVisited.has(id)) {
            return [];
          }
          iVisited.add(id);

          return this.incomings.get(id) ?? [];
        });
    }
    while (newOutgoings.length > 0) {
      newOutgoings = newOutgoings
        .flatMap(e => {
          this.highlightEdge(e, "outgoing");

          let id = e.dataset.to;
          if (oVisited.has(id)) {
            return [];
          }
          oVisited.add(id);

          return this.outgoings.get(id) ?? [];
        });
    }
  }
}
