import { Component } from "solid-js";

import { Graph } from "./graph/types";

import "./styles/main.css";
import "./App.css";

import Topbar from "./components/Topbar";
import GraphViewport from "./components/GraphViewport";

const App: Component<{
  graph: Graph;
  focus: {
    path: string;
    line: number;
    character: number;
  } | null;
}> = (props) => {
  let focus: string | null = null;
  if (props.focus) {
    const fileId = props.focus && props.graph.files.find((f) => f.path == props.focus!.path)
      ?.id!;

    focus = `${fileId}:${props.focus!.line}_${props.focus!.character}`;
  }

  return (
    <>
      <div id="topbar">
        <Topbar focus={props.focus != null} />
      </div>
      <div id="container">
        <GraphViewport graph={props.graph} focus={focus} />
      </div>
    </>
  );
};

export default App;
