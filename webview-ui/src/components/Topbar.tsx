import { Component } from "solid-js";

import { useAppContext, ScaleOption } from "../context.tsx";
import ComboBox from "./ComboBox.tsx";
import Switch from "./Switch.tsx";

import "./Topbar.css";

import collapse from "../assets/collapse.svg";
import expand from "../assets/expand.svg";

export default function Topbar() {
  const [{}, { setCollapse }] = useAppContext();

  return (
    <div class="toolbar">
      <ComboBox />
      <Switch
        onChange={(isChecked) => {
          setCollapse(!isChecked);
        }}
        title="switch to expand files"
        titleChecked="switch to collapse files"
        icon={collapse}
        iconChecked={expand}
      />
      <ScaleControl />
      <button>Save</button>
    </div>
  );
}

const ScaleControl: Component = () => {
  const [{}, { setScaleOpt }] = useAppContext();

  return (
    <div>
      <button onClick={() => setScaleOpt(ScaleOption.ZoomOut)}>-</button>
      <button onClick={() => setScaleOpt(ScaleOption.Reset)}>Reset</button>
      <button onClick={() => setScaleOpt(ScaleOption.ZoomIn)}>+</button>
    </div>
  );
};
