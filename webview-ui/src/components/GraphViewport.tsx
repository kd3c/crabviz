import {
  createEffect,
  createResource,
  on,
  onMount,
  Component,
  Suspense,
} from "solid-js";
import createPanZoom from "panzoom";

import { useAppContext, ScaleOption } from "../context";
import { Graph } from "../graph/types";
import { convert } from "../graph/graphviz";
import { renderSVG } from "../graph/svg-renderer";

import Spinner from "./Spinner";

import "./GraphViewport.css";

const GraphViewport: Component<{
  graph: Graph;
}> = ({ graph }) => {
  const [
    { collapse, selectedElem, scaleOpt },
    { setItems, setSelectedElem, setScaleOpt },
  ] = useAppContext();

  const svgCache = new Map<boolean, SVGSVGElement>();
  let clickPoint = [0, 0];

  const [svg] = createResource(
    // `fetcher` won't be called if the value of `source` is false, so here I change it to number
    () => (collapse() ? 1 : 2),
    async (collapse) => {
      const isCollapsed = collapse == 1;

      if (!svgCache.has(isCollapsed)) {
        const svg = await renderSVG(convert(graph, isCollapsed));
        svgCache.set(isCollapsed, svg);

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
              setSelectedElem(elem);
              return;
            }
          }

          setSelectedElem(null);
        };
      }

      return svgCache.get(isCollapsed)!;
    }
  );

  let nodes: NodeListOf<SVGGElement> | undefined = undefined;
  let edges: NodeListOf<SVGGElement> | undefined = undefined;
  let state: ReturnType<typeof createPanZoomState> | undefined = undefined;

  onMount(() => {
    createEffect(
      on(svg, (svg) => {
        if (!svg) {
          return;
        }

        // manually reset styles for the previous graph
        // if I just call `setSelectedElem(null)`, it would reset styles for the current graph because of the auto-batch feature
        resetStyles();

        nodes = svg.querySelectorAll<SVGGElement>("g.node");
        edges = svg.querySelectorAll<SVGGElement>("g.edge");
        state = createPanZoomState(svg);

        setSelectedElem(null);
        setScaleOpt(ScaleOption.Reset);
        setItems({
          files: new Map(Array.from(nodes, (e) => [e.id, e])),
          symbols: Array.from(
            svg.querySelectorAll<SVGElement>(".cell").values()
          ),
        });
      })
    );

    createEffect(
      on(
        scaleOpt,
        (opt) => {
          if (!state) {
            return;
          }
          const { pz, x, y, scale, cx, cy } = state;

          switch (opt) {
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
        },
        { defer: true }
      )
    );

    createEffect(
      on(
        selectedElem,
        (elem) => {
          if (!state) {
            return;
          }
          const { pz, sRect } = state;

          resetStyles();

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
        },
        { defer: true }
      )
    );
  });

  function resetStyles() {
    nodes?.forEach((node) => {
      node.classList.remove("selected");
      node.querySelectorAll("g.cell.selected").forEach((elem) => {
        elem.classList.remove("selected");
      });
    });
    edges?.forEach((edge) =>
      edge.classList.remove("fade", "incoming", "outgoing", "selected")
    );
  }

  function onSelectNode(node: SVGElement) {
    const id = node.id;

    edges?.forEach((edge) => {
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

  function onSelectCell(cell: SVGElement) {
    const id = cell.id;

    edges?.forEach((edge) => {
      let fade = true;

      if (edge.dataset.from == id.toString()) {
        edge.classList.add("outgoing");
        fade = false;
      }
      if (edge.dataset.to == id.toString()) {
        edge.classList.add("incoming");
        fade = false;
      }

      if (fade) {
        edge.classList.add("fade");
      }
    });

    cell.classList.add("selected");
  }

  function onSelectEdge(edge: SVGElement) {
    edges!.forEach((e) => {
      if (e !== edge) {
        e.classList.add("fade");
      }
    });
  }

  function onSelctCluster(clusterLabel: SVGElement) {
    const cluster = clusterLabel.parentNode! as SVGGElement;
    const rect = cluster.getBoundingClientRect();

    const selected = new Set();
    nodes?.forEach((node) => {
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

    edges?.forEach((edge) => {
      let fade = true;

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
  }

  return (
    <Suspense fallback={<Spinner />}>
      <div class="viewport">{svg()}</div>
    </Suspense>
  );
};

function createPanZoomState(svg: SVGSVGElement) {
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

export default GraphViewport;
