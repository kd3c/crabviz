import { Suspense, lazy } from "solid-js";

import Topbar from "./components/Topbar";
import GraphViewport from "./components/GraphViewport";
import Spinner from "./components/Spinner";
import { renderSVG } from "./svg-renderer";

import "./App.css";

function App(dot: string) {
  const AsnycGraphViewport = lazy(async () => {
    const svg = await renderSVG(dot);
    return Promise.resolve({ default: () => GraphViewport(svg) });
  });

  return (
    <>
      <div id="topbar">
        <Topbar />
      </div>
      <div id="container">
        <Suspense fallback={<Spinner />}>
          <AsnycGraphViewport />
        </Suspense>
      </div>
    </>
  );
}

export default App;
