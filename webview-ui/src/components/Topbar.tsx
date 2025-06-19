import { Component, createSignal, Show } from "solid-js";

import { useAppContext, ScaleOption, ExportOption } from "../context.tsx";

import ComboBox from "./ComboBox.tsx";
import Switch from "./Switch.tsx";
import Popover from "./Popover.tsx";

import "./Topbar.css";

import svgCollapse from "../assets/collapse.svg?raw";
import svgExpand from "../assets/expand.svg?raw";
import svgPlus from "../assets/plus.svg?raw";
import svgMinus from "../assets/minus.svg?raw";

const Topbar: Component<{ focus: boolean }> = (props) => {
  const [{}, { setCollapse, setScaleOpt, setExportOpt }] = useAppContext();

  const [showSaveOptions, setShowSaveOptions] = createSignal(false);

  return (
    <div class="topbar">
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

      <button class="button save-btn" onClick={() => setShowSaveOptions(true)}>
        Save
        <Popover signal={[showSaveOptions, setShowSaveOptions]}>
          <div class="option-list">
            <label>as ...</label>
            <div class="option"
              onClick={() => {
                setExportOpt(ExportOption.Html);
                setShowSaveOptions(false);
              }}
            >
              HTML
            </div>
            <div class="option"
              onClick={() => {
                setExportOpt(ExportOption.Svg);
                setShowSaveOptions(false);
              }}
            >
              SVG
            </div>
          </div>
        </Popover>
      </button>
    </div>
  );
};

export default Topbar;
