import { Component } from "solid-js";

import { useAppContext, ScaleOption } from "../context.tsx";

import ComboBox from "./ComboBox.tsx";
import Switch from "./Switch.tsx";

import "./Topbar.css";

import collapseSvg from "../assets/collapse.svg?raw";
import expandSvg from "../assets/expand.svg?raw";
import plusSvg from "../assets/plus.svg?raw";
import minusSvg from "../assets/minus.svg?raw";

const Topbar: Component = () => {
  const [{}, { setCollapse, setScaleOpt }] = useAppContext();

  return (
    <div class="toolbar">
      <ComboBox />

      <Switch
        onChange={(isChecked) => {
          setCollapse(!isChecked);
        }}
        title="switch to expand files"
        titleChecked="switch to collapse files"
        icon={collapseSvg}
        iconChecked={expandSvg}
      />

      <div role="group" class="button-group">
        <button class="button" onClick={() => setScaleOpt(ScaleOption.ZoomOut)} innerHTML={minusSvg}>
        </button>
        <button class="button" onClick={() => setScaleOpt(ScaleOption.Reset)}>
          Reset
        </button>
        <button class="button" onClick={() => setScaleOpt(ScaleOption.ZoomIn)} innerHTML={plusSvg}>
        </button>
      </div>

      <button class="button">Save</button>
    </div>
  );
};

export default Topbar;
