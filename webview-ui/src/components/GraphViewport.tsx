import { createEffect, onMount } from "solid-js";

import { useAppContext } from "../context";

import "./GraphViewport.css";

export default function GraphViewport(svg: SVGSVGElement) {
  const [{ selectedElem }, { setItems, setSelectedElem }] = useAppContext();
  createEffect(() => {
    reset();

    const elem = selectedElem();
    if (!elem) {
      return;
    }

    if (elem.dataset.path) {
      onSelectNode(elem);
    } else if (elem.dataset.kind) {
      onSelectCell(elem);
    } else if (elem.dataset.from) {
      onSelectEdge(elem);
    }
  });

  let clickPoint = [0, 0];
  const nodes = svg.querySelectorAll("g.node");
  const edges = svg.querySelectorAll("g.edge");

  onMount(() => {
    setItems({
      files: new Map(
        Array.from(svg.querySelectorAll<SVGElement>(".node"), (e) => [e.id, e])
      ),
      symbols: Array.from(svg.querySelectorAll<SVGElement>(".cell").values()),
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
        classes.contains("edge")
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

      if (edge.matches(`[data-from^="${id}:"]`)) {
        edge.classList.add("outgoing");
        fade = false;
      }
      if (edge.matches(`[data-to^="${id}:"]`)) {
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

  return <div class="viewport">{svg}</div>;
}
