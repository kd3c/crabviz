import { Component, Show } from "solid-js";

import { useAppContext, ScaleOption, ExportOption } from "../context.tsx";

import ComboBox from "./ComboBox.tsx";
import Switch from "./Switch.tsx";

import "./Topbar.css";

import svgCollapse from "../assets/collapse.svg?raw";
import svgExpand from "../assets/expand.svg?raw";
import svgPlus from "../assets/plus.svg?raw";
import svgMinus from "../assets/minus.svg?raw";

const Topbar: Component<{ focus: boolean }> = (props) => {
  const [{}, { setCollapse, setScaleOpt, setExportOpt }] = useAppContext();

  return (
    <div class="toolbar">
      <ComboBox />

      <Show when={!props.focus}>
        <Switch
          onChange={(isChecked) => {
            setCollapse(!isChecked);
          }}
          title="switch to expand files"
          titleChecked="switch to collapse files"
          icon={svgCollapse}
          iconChecked={svgExpand}
        />
      </Show>

      <div role="group" class="button-group">
        <button
          class="button"
          onClick={() => setScaleOpt(ScaleOption.ZoomOut)}
          innerHTML={svgMinus}
        ></button>
        <button class="button" onClick={() => setScaleOpt(ScaleOption.Reset)}>
          Reset
        </button>
        <button
          class="button"
          onClick={() => setScaleOpt(ScaleOption.ZoomIn)}
          innerHTML={svgPlus}
        ></button>
      </div>

      <button
        class="button"
        onClick={() => {
          setExportOpt(ExportOption.Svg);
        }}
      >
        Save
      </button>
    </div>
  );
};

export default Topbar;
