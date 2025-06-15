import { ParentComponent, Show, Signal } from "solid-js";
import { Portal } from "solid-js/web";

import "./Popover.css";

const Popover: ParentComponent<{ signal: Signal<boolean> }> = (props) => {
  const [show, setShow] = props.signal;

  return (
    <Show when={show()}>
      <Portal>
        <div
          style={{
            "background-color": "transparent",
            position: "absolute",
            top: 0,
            height: "100vh",
            width: "100vw",
          }}
          onClick={() => setShow(false)}
        ></div>
      </Portal>

      <div
        class="popover"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {props.children}
      </div>
    </Show>
  );
};

export default Popover;
