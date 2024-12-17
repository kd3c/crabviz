import { Component } from "solid-js";

import { useAppContext, ScaleOption } from "../context.tsx";
import ComboBox from "./ComboBox.tsx";

import "./Topbar.css";

export default function Topbar() {
  return (
    <div class="toolbar">
      <div class="toolbar-combo-box">
        <ComboBox />
      </div>
      <button>Save</button>
      <ScaleControl />
    </div>
  );
}

const ScaleControl: Component = () => {
  const [{},{ setScaleOpt }] = useAppContext();

  return (
    <div>
      <button onClick={() => setScaleOpt(ScaleOption.ZoomOut)}>-</button>
      <button onClick={() => setScaleOpt(ScaleOption.Reset)}>Reset</button>
      <button onClick={() => setScaleOpt(ScaleOption.ZoomIn)}>+</button>
    </div>
  );
};
