import {
  createEffect,
  createMemo,
  createSignal,
  Component,
  Show,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { VList } from "virtua/solid";

import { useAppContext } from "../context";
import Spinner from "./Spinner";
import { kindNumStr2Name } from "../lsp";

import "./ComboBox.css";

interface IOption {
  id: string;
  label: string;
  kind: string | null;
  detail: string | null;
}

export default function ComboBox() {
  const [{ items, selectedElem }, { setSelectedElem }] = useAppContext();

  const [searchMode, setSearchMode] = createSignal(true);

  let inputRef: HTMLInputElement | undefined;
  const [inputFocused, setInputFocused] = createSignal(false);
  const [value, setValue] = createSignal("");

  const toggle = () => {
    setSearchMode(!searchMode());
    if (searchMode()) {
      inputRef?.focus();
    }
  };

  const options = createMemo(() => {
    const _items = items();
    if (!_items) {
      return undefined;
    }

    const files = Array.from(_items.files.values(), file2option);
    const symbols = _items.symbols.map(symbol2option);

    return files.concat(symbols).sort((a, b) => {
      return a.id.localeCompare(b.id);
    });
  });
  const filtered = createMemo(() => {
    const query = value()?.toLowerCase();
    if (!query) {
      return options();
    }
    return options()?.filter((o) => o.label.toLowerCase().includes(query));
  });

  const jump = () => {
    const elem = selectedElem();
    if (!elem || elem.dataset.from) {
      return;
    }

    let file_id: string;
    let ln = 0,
      col = 0;
    if (!elem.dataset.kind) {
      file_id = elem.id;
    } else {
      let s = elem.id.split(":");
      file_id = s[0];
      [ln, col] = s[1].split("_").map((s) => parseInt(s));
    }

    elem.id.split(":");
    window.postMessage({
      command: "go to definition",
      path: items()!.files.get(file_id)!.dataset.path,
      ln,
      col,
    });
  };

  const isSymbolSelected = () =>
    selectedElem() && !selectedElem()?.dataset.from;

  createEffect(() => {
    if (selectedElem()) {
      setSearchMode(false);
    }
  });

  return (
    <div class="combo-box">
      <button onClick={toggle} disabled={!isSymbolSelected()}>
        S
      </button>

      <Dynamic
        component={
          !isSymbolSelected() || searchMode()
            ? () => (
                <input
                  ref={inputRef}
                  type="search"
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  value={value()}
                  onInput={(e) => setValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                ></input>
              )
            : () => (
                <>
                  <div class="combo-box-selection">
                    <Option option={elem2option(selectedElem()!)} />
                  </div>
                  <button onClick={jump}>Go</button>
                </>
              )
        }
      ></Dynamic>

      <Show when={inputFocused()}>
        <div class="combo-box-dropdown">
          <Show when={filtered() !== undefined} fallback={<Spinner />}>
            <VList
              data={filtered()!}
              style={{
                height: `min(calc(${
                  filtered()!.length
                } * var(--row-height)), var(--dropdown-max-height))`,
              }}
            >
              {(option) => (
                <Option
                  option={option}
                  onClick={(o) => {
                    setSelectedElem(
                      document.querySelector<SVGElement>(`[id="${o.id}"]`)!
                    );
                  }}
                />
              )}
            </VList>
          </Show>
        </div>
      </Show>
    </div>
  );
}

const Option: Component<{
  option: IOption;
  onClick?: (option: IOption) => void;
}> = (props) => {
  const option = props.option,
    onClick = props.onClick;

  return (
    <div
      class="option"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onClick && onClick(option)}
    >
      <div class="option-h">
        <Show when={option.kind !== null}>
          <span class="kind">{option.kind}</span>
        </Show>
        <div class="label">{option.label}</div>
      </div>
      <Show when={option.detail !== null}>
        <div class="detail">{option.detail}</div>
      </Show>
    </div>
  );
};

const elem2option = (e: SVGElement): IOption => {
  if (e.dataset.path) {
    return file2option(e);
  } else {
    return symbol2option(e);
  }
};

const file2option = (e: SVGElement): IOption => {
  return {
    id: e.id,
    label: e.querySelector(".title")!.firstElementChild!.textContent!,
    kind: null,
    detail: e.dataset.path!,
  };
};

const symbol2option = (e: SVGElement): IOption => {
  return {
    id: e.id,
    label: e.querySelector(":scope > text:last-of-type")!.textContent!,
    kind: kindNumStr2Name(e.dataset.kind!),
    detail: null,
  };
};
