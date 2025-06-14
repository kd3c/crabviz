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
import { renderSVG, RenderOutput } from "../graph/render";

import Spinner from "./Spinner";

import "./GraphViewport.css";
import svgStyles from "../assets/out/svg.css?raw";

const GraphViewport: Component<{
  graph: Graph;
  focus: string | null;
}> = (props) => {
  const [
    { collapse, selectedElem, scaleOpt, exportOpt },
    { setItems, setSelectedElem, setScaleOpt },
  ] = useAppContext();

  const cache = new Map<boolean, RenderOutput>();
  let clickPoint = [0, 0];

  const [content] = createResource(
    // `fetcher` won't be called if the value of `source` is false, so here I change it to number
    () => (collapse() ? 1 : 2),
    async (collapse) => {
      const isCollapsed = collapse == 1;

      if (!cache.has(isCollapsed)) {
        const output = await renderSVG(
          convert(props.graph, isCollapsed),
          props.focus
        );
        cache.set(isCollapsed, output);

        output.svg.onmousedown = function (e) {
          clickPoint = [e.pageX, e.pageY];
        };
        output.svg.onmouseup = function (e) {
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
            elem && elem instanceof SVGElement && elem !== output.svg;
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

      return cache.get(isCollapsed)!;
    }
  );

  let nodes: NodeListOf<SVGGElement> | undefined = undefined;
  let edges: NodeListOf<SVGGElement> | undefined = undefined;
  let state: ReturnType<typeof createPanZoomState> | undefined = undefined;

  onMount(() => {
    createEffect(
      on(content, (content) => {
        if (!content) {
          return;
        }

        // manually reset styles for the previous graph
        // if I just call `setSelectedElem(null)`, it would reset styles for the current graph because of the auto-batch feature
        resetStyles();

        nodes = content.svg.querySelectorAll<SVGGElement>("g.node");
        edges = content.svg.querySelectorAll<SVGGElement>("g.edge");
        state = createPanZoomState(content.svg);

        setSelectedElem(null);
        setScaleOpt(ScaleOption.Reset);
        setItems({
          files: new Map(Array.from(nodes, (e) => [e.id, e])),
          symbols: Array.from(
            content.svg.querySelectorAll<SVGElement>(".cell").values()
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

    createEffect(
      on(
        exportOpt,
        () => {
          const svg = content()!.svg;
          const width = state!.width,
            height = state!.height;

          window.postMessage({
            command: "save SVG",
            svg: `<svg class="callgraph" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}">
              <style>${svgStyles}</style>
              ${svg.innerHTML.replaceAll("&nbsp;", "&#160;")}
            </svg>`,
          });
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

    if (props.focus) {
      onSelectCellInFocusMode(id);
    } else {
      const cellIds = new Set([cell.id]);
      cell.querySelectorAll(".cell").forEach((c) => {
        cellIds.add(c.id);
      });

      highlightEdges((edge) => [
        cellIds.has(edge.dataset.to!),
        cellIds.has(edge.dataset.from!),
      ]);
    }

    cell.classList.add("selected");
  }

  function onSelectCellInFocusMode(cellId: string) {
    const highlights = [new Set<SVGGElement>(), new Set<SVGGElement>()];
    const inout = [content()!.incomings, content()!.outgoings];

    for (let i = 0; i < inout.length; ++i) {
      const visited = new Set([cellId, props.focus!]);
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

    highlightEdges((edge) => [
      highlights[0].has(edge),
      highlights[1].has(edge),
    ]);
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

  function highlightEdges(judge: (edge: SVGGElement) => [boolean, boolean]) {
    edges?.forEach((edge) => {
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

  return (
    <Suspense fallback={<Spinner />}>
      <div class="viewport">{content()?.svg}</div>
    </Suspense>
  );
};

function createPanZoomState(svg: SVGSVGElement) {
  const width = svg.width.baseVal.value;
  const height = svg.height.baseVal.value;

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
    width,
    height,
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
