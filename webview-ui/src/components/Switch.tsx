import { createSignal, Component } from "solid-js";

import "./Switch.css";

const Switch: Component<{
  onChange: (isChecked: boolean) => void;
  icon: string;
  iconChecked: string;
  title: string;
  titleChecked: string;
}> = (props) => {
  const { onChange, icon, iconChecked, title, titleChecked } = props;
  const [isChecked, setIsChecked] = createSignal(true);

  const toggle = () => {
    setIsChecked(!isChecked());
    onChange(isChecked());
  };

  return (
    <label class="switch" title={isChecked() ? titleChecked : title}>
      <input type="checkbox" onChange={toggle} checked={isChecked()} />
      <span class="slider">
        <img src={isChecked() ? iconChecked : icon} class="icon" />
      </span>
    </label>
  );
};

export default Switch;
