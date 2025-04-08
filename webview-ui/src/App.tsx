import { Component } from "solid-js";

import { Graph } from "./graph/types";

import Topbar from "./components/Topbar";
import GraphViewport from "./components/GraphViewport";

import "./App.css";

const App: Component<{
  graph: Graph;
  // collapse: boolean,
}> = (props) => {
  return (
    <>
      <div id="topbar">
        <Topbar />
      </div>
      <div id="container">
        <GraphViewport graph={props.graph} />
      </div>
    </>
  );
};

export default App;
