import createPanZoom from "panzoom";

export class CallGraph {
  readonly svg: SVGSVGElement;
  readonly nodes: NodeListOf<SVGGElement>;
  readonly edges: NodeListOf<SVGGElement>;
  readonly clusters: NodeListOf<SVGGElement>;
  readonly width: number;
  readonly height: number;
  panZoomState?: ReturnType<typeof this.createPanZoomState>;

  focus: string | null;
  incomings?: Map<string, SVGGElement[]>;
  outgoings?: Map<string, SVGGElement[]>;

  public constructor(
    svg: SVGSVGElement,
    focus: string | null,
    onSelectElem?: (elem: SVGElement | null) => void
  ) {
    this.svg = svg;
    this.nodes = svg.querySelectorAll("g.node");
    this.edges = svg.querySelectorAll("g.edge");
    this.clusters = svg.querySelectorAll("g.cluster");
    this.width = this.svg.width.baseVal.value;
    this.height = this.svg.height.baseVal.value;
    this.setUpInteraction(onSelectElem ?? this.onSelectElem);

    this.focus = focus;
    if (focus) {
      const incomings = new Map();
      const outgoings = new Map();

      this.edges.forEach((edge) => {
        const fromCell = edge.dataset.from,
          toCell = edge.dataset.to;

        incomings.get(toCell)?.push(edge) ?? incomings.set(toCell, [edge]);
        outgoings.get(fromCell)?.push(edge) ?? outgoings.set(fromCell, [edge]);
      });

      this.incomings = incomings;
      this.outgoings = outgoings;
    }
  }

  setUpInteraction(onSelectElem: (elem: SVGElement | null) => void) {
    const svg = this.svg;
    let clickPoint = [0, 0];

    svg.onmousedown = function (e) {
      clickPoint = [e.pageX, e.pageY];
    };
    svg.onmouseup = function (e) {
      const delta = 6;
      const [x, y] = clickPoint;
      const diffX = Math.abs(e.pageX - x);
      const diffY = Math.abs(e.pageY - y);

      if (diffX > delta || diffY > delta) {
        // a mouse drag event
        return;
      }

      for (
        let elem = e.target;
        elem && elem instanceof SVGElement && elem !== svg;
        elem = elem.parentNode
      ) {
        const classes = elem.classList;
        if (
          classes.contains("node") ||
          classes.contains("cell") ||
          classes.contains("edge") ||
          classes.contains("cluster-label")
        ) {
          onSelectElem(elem);
          return;
        }
      }
      onSelectElem(null);
    };
  }

  setUpPanZoom() {
    this.panZoomState = this.createPanZoomState();
  }

  createPanZoomState() {
    const container = this.svg.querySelector<SVGElement>("#graph0")!;
    const pz = createPanZoom(container, {
      smoothScroll: false,
      autocenter: true,
    });

    const { x, y, scale } = structuredClone(pz.getTransform());
    const cRect = container.getBoundingClientRect();
    const cx = cRect.x + cRect.width / 2;
    const cy = cRect.y + cRect.height / 2;
    const sRect = this.svg.getBoundingClientRect();

    return {
      pz,
      scale,
      x,
      y,
      cx,
      cy,
      cRect,
      sRect,
    };
  }

  public resetStyles() {
    this.nodes.forEach((node) => {
      node.classList.remove("selected");
      node.querySelectorAll("g.selected").forEach((elem) => {
        elem.classList.remove("selected");
      });
    });
    this.edges.forEach((edge) =>
      edge.classList.remove("fade", "incoming", "outgoing", "selected")
    );
    this.clusters.forEach((cluster) => cluster.classList.remove("selected"));
  }

  public smoothZoom(scale: number) {
    if (!this.panZoomState) {
      return;
    }

    const { pz, cx, cy } = this.panZoomState;
    pz.smoothZoom(cx, cy, scale);
  }

  public resetPanZoom() {
    if (!this.panZoomState) {
      return;
    }

    const { pz, x, y, scale } = this.panZoomState;
    pz.moveTo(x, y);
    pz.zoomAbs(x, y, scale);
  }

  public onSelectElem = (elem: SVGElement | null) => {
    this.resetStyles();

    if (!elem) {
      return;
    }

    const { pz, sRect } = this.panZoomState!;
    const eRect = elem.getBoundingClientRect();
    if (
      eRect.left < sRect.left ||
      eRect.top < sRect.top ||
      eRect.right > sRect.right ||
      eRect.bottom > sRect.bottom
    ) {
      pz.centerOn(elem);
    }

    const classes = elem.classList;
    if (classes.contains("node")) {
      this.onSelectNode(elem);
    } else if (classes.contains("cell")) {
      this.onSelectCell(elem);
    } else if (classes.contains("edge")) {
      this.onSelectEdge(elem);
    } else if (classes.contains("cluster-label")) {
      this.onSelctCluster(elem);
    }
  };

  onSelectNode(node: SVGElement) {
    const id = node.id;

    this.edges.forEach((edge) => {
      let fade = true;

      if (edge.dataset.from?.startsWith(`${id}:`)) {
        edge.classList.add("outgoing");
        fade = false;
      }
      if (edge.dataset.to?.startsWith(`${id}:`)) {
        edge.classList.add("incoming");
        fade = false;
      }

      if (fade) {
        edge.classList.add("fade");
      }
    });

    node.classList.add("selected");
  }

  onSelectCell(cell: SVGElement) {
    const id = cell.id;

    if (this.focus) {
      this.onSelectCellInFocusMode(id);
    } else {
      const cellIds = new Set([cell.id]);
      cell.querySelectorAll(".cell").forEach((c) => {
        cellIds.add(c.id);
      });

      this.highlightEdges((edge) => [
        cellIds.has(edge.dataset.to!),
        cellIds.has(edge.dataset.from!),
      ]);
    }

    cell.classList.add("selected");
  }

  onSelectCellInFocusMode(cellId: string) {
    const highlights = [new Set<SVGGElement>(), new Set<SVGGElement>()];
    const inout = [this.incomings!, this.outgoings!];

    for (let i = 0; i < inout.length; ++i) {
      const visited = new Set([cellId, focus!]);
      const map = inout[i];
      const highlightEdges = highlights[i];

      for (let newEdges = map.get(cellId) ?? []; newEdges.length > 0; ) {
        newEdges = newEdges.flatMap((edge) => {
          highlightEdges.add(edge);

          const id = i == 0 ? edge.dataset.from! : edge.dataset.to!;
          if (visited.has(id)) {
            return [];
          }

          visited.add(id);
          return map.get(id) ?? [];
        });
      }
    }

    this.highlightEdges((edge) => [
      highlights[0].has(edge),
      highlights[1].has(edge),
    ]);
  }

  onSelectEdge(edge: SVGElement) {
    this.edges.forEach((e) => {
      if (e !== edge) {
        e.classList.add("fade");
      }
    });
  }

  onSelctCluster(clusterLabel: SVGElement) {
    const cluster = clusterLabel.parentNode! as SVGGElement;
    const rect = cluster.getBoundingClientRect();

    cluster.classList.add("selected");

    const selected = new Set();
    this.nodes.forEach((node) => {
      const nRect = node.getBoundingClientRect();

      if (
        nRect.left > rect.left &&
        nRect.right < rect.right &&
        nRect.bottom < rect.bottom &&
        nRect.top > rect.top
      ) {
        selected.add(node.id);
      }
    });

    this.highlightEdges((edge) => {
      let from = edge.dataset.from!;
      let i = from.indexOf(":");
      if (i > 0) {
        from = from.substring(0, i);
      }

      let to = edge.dataset.to!;
      i = to.indexOf(":");
      if (i > 0) {
        to = to.substring(0, i);
      }

      return [selected.has(to), selected.has(from)];
    });
  }

  highlightEdges(judge: (edge: SVGGElement) => [boolean, boolean]) {
    this.edges.forEach((edge) => {
      let fade = true;

      const [incoming, outgoing] = judge(edge);
      if (incoming) {
        edge.classList.add("incoming");
        fade = false;
      }
      if (outgoing) {
        edge.classList.add("outgoing");
        fade = false;
      }

      if (fade) {
        edge.classList.add("fade");
      }
    });
  }
}

console.log(CallGraph);
