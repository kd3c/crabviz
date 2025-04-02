import { createEffect, JSX, onMount } from "solid-js";
import createPanZoom from "panzoom";

import { useAppContext, ScaleOption } from "../context";

import "./GraphViewport.css";

interface GraphViewportProps {
  svg: SVGSVGElement;
}

export default function GraphViewport(props: GraphViewportProps): JSX.Element {
  const { svg } = props;

  const [{ selectedElem, scaleOpt }, { setItems, setSelectedElem }] =
    useAppContext();

  let clickPoint = [0, 0];
  const nodes = svg.querySelectorAll<SVGGElement>("g.node");
  const edges = svg.querySelectorAll<SVGGElement>("g.edge");

  setItems({
    files: new Map(Array.from(nodes, (e) => [e.id, e])),
    symbols: Array.from(svg.querySelectorAll<SVGElement>(".cell").values()),
  });

  onMount(() => {
    const container = svg.querySelector<SVGElement>("#graph0")!;
    const pz = createPanZoom(container, {
      smoothScroll: false,
      autocenter: true,
    });

    const { x, y, scale } = structuredClone(pz.getTransform());
    const cRect = container.getBoundingClientRect();
    const cx = cRect.x + cRect.width / 2;
    const cy = cRect.y + cRect.height / 2;
    const sRect = svg.getBoundingClientRect();

    createEffect(() => {
      switch (scaleOpt()) {
        case ScaleOption.ZoomIn:
          pz.smoothZoom(cx, cy, 2);
          break;
        case ScaleOption.ZoomOut:
          pz.smoothZoom(cx, cy, 0.5);
          break;
        case ScaleOption.Reset:
          pz.moveTo(x, y);
          pz.zoomAbs(x, y, scale);
          break;
      }
    });

    createEffect(() => {
      reset();

      const elem = selectedElem();
      if (!elem) {
        return;
      }

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
        onSelectNode(elem);
      } else if (classes.contains("cell")) {
        onSelectCell(elem);
      } else if (classes.contains("edge")) {
        onSelectEdge(elem);
      } else if (classes.contains("cluster-label")) {
        onSelctCluster(elem);
      }
    });
  });

  svg.onmousedown = (e) => {
    clickPoint = [e.pageX, e.pageY];
  };
  svg.onmouseup = (e) => {
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
        setSelectedElem(elem);
        return;
      }
    }

    setSelectedElem(undefined);
  };

  const reset = () => {
    nodes.forEach((node) => {
      node.classList.remove("selected");
      node.querySelectorAll("g.cell.selected").forEach((elem) => {
        elem.classList.remove("selected");
      });
    });
    edges.forEach((edge) =>
      edge.classList.remove("fade", "incoming", "outgoing", "selected")
    );
  };

  const onSelectNode = (node: SVGElement) => {
    const id = node.id;

    edges.forEach((edge) => {
      let fade = true;

      if (edge.dataset.from?.startsWith(id)) {
        edge.classList.add("outgoing");
        fade = false;
      }
      if (edge.dataset.to?.startsWith(id)) {
        edge.classList.add("incoming");
        fade = false;
      }

      if (fade) {
        edge.classList.add("fade");
      }
    });

    node.classList.add("selected");
  };

  const onSelectCell = (cell: SVGElement) => {
    const id = cell.id;

    edges.forEach((edge) => {
      let fade = true;

      if (edge.matches(`[data-from="${id}"]`)) {
        edge.classList.add("outgoing");
        fade = false;
      }
      if (edge.matches(`[data-to="${id}"]`)) {
        edge.classList.add("incoming");
        fade = false;
      }

      if (fade) {
        edge.classList.add("fade");
      }
    });

    cell.classList.add("selected");
  };

  const onSelectEdge = (edge: SVGElement) => {
    edges.forEach((e) => {
      if (e !== edge) {
        e.classList.add("fade");
      }
    });
  };

  const onSelctCluster = (clusterLabel: SVGElement) => {
    const cluster = clusterLabel.parentNode! as SVGGElement;
    const rect = cluster.getBoundingClientRect();

    const selected = new Set();
    nodes.forEach((node) => {
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

    edges.forEach((edge) => {
      let fade = true;

      let from = edge.dataset.from!;
      from = from.substring(0, from.indexOf(":"));
      let to = edge.dataset.to!;
      to = to.substring(0, to.indexOf(":"));

      if (selected.has(from)) {
        edge.classList.add("outgoing");
        fade = false;
      }
      if (selected.has(to)) {
        edge.classList.add("incoming");
        fade = false;
      }

      if (fade) {
        edge.classList.add("fade");
      }
    });
  };

  return <div class="viewport">{svg}</div>;
}
