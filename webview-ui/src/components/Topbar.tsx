import ComboBox from "./ComboBox.tsx";
import './Topbar.css';

export default function Topbar() {
  return (
    <div class="toolbar">
      <div class="toolbar-combo-box">
        <ComboBox />
      </div>
      <button>Save</button>
    </div>
  );
}
