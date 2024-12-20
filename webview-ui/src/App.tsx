import { Component, Show, Suspense, createResource } from "solid-js";

import { Graph } from "./graph/types";
import { convert } from "./graph/graphviz";

import Topbar from "./components/Topbar";
import GraphViewport from "./components/GraphViewport";
import Spinner from "./components/Spinner";
import { renderSVG } from "./graph/svg-renderer";

import "./App.css";

interface CrabvizProps {
  graph: Graph;
}

const App: Component<CrabvizProps> = (props) => {
  const { graph } = props;
  console.log(graph);

  const [svg] = createResource(async () => renderSVG(convert(graph)));

  return (
    <Suspense fallback={<Spinner />}>
      <div id="topbar">
        <Topbar />
      </div>
      <div id="container">
        <Show when={svg()}>
          <GraphViewport svg={svg()!} />
        </Show>
      </div>
    </Suspense>
  );
};

export default App;
