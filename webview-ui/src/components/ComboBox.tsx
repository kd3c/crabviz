import {
  createMemo,
  createSignal,
  Component,
  Show,
  batch,
  Suspense,
} from "solid-js";
import { Dynamic, template } from "solid-js/web";
import { VList } from "virtua/solid";

import Popover from "./Popover";
import Spinner from "./Spinner";

import { useAppContext } from "../context";
import { kindNumStr2Name } from "../lsp";

import "./ComboBox.css";
import svgSearch from "../assets/search.svg?raw";
import svgGoto from "../assets/goto.svg?raw";
import svgSelect from "../assets/select.svg?raw";

interface IOption {
  id: string;
  label: string;
  kind: string | null;
  detail: string | null;
}

export default function ComboBox() {
  const [{ items, selectedElem }, { setSelectedElem }] = useAppContext();

  const [value, setValue] = createSignal("");
  const [isSearching, setIsSearching] = createSignal(false);

  const options = createMemo(() => {
    const _items = items();
    if (!_items) {
      return undefined;
    }

    const files = Array.from(_items.files.values(), file2option);
    const symbols = _items.symbols.map(symbol2option);

    return files.concat(symbols).sort((a, b) => a.id.localeCompare(b.id));
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
    if (!elem) {
      return;
    }
    const classes = elem.classList;

    let file_id: string;
    let ln = 0,
      col = 0;
    if (classes.contains("node")) {
      file_id = elem.id;
    } else {
      let s = elem.id.split(":");
      file_id = s[0];
      [ln, col] = s[1].split("_").map((s) => parseInt(s));
    }

    window.postMessage({
      command: "go to definition",
      path: items()!.files.get(file_id)!.dataset.path,
      ln,
      col,
    });
  };

  const isSymbolSelected = () => {
    const classes = selectedElem()?.classList;
    return classes?.contains("cell") || classes?.contains("node");
  };

  return (
    <div class="combo-box">
      <Dynamic
        component={
          isSymbolSelected()
            ? () => (
                <div class="bar">
                  <button
                    class="button"
                    onClick={() => setIsSearching(true)}
                    innerHTML={svgSearch}
                  ></button>
                  <Option option={elem2option(selectedElem()!)} />
                  <button
                    class="button"
                    onClick={jump}
                    innerHTML={svgGoto}
                  ></button>
                </div>
              )
            : () => (
                <button class="select-btn" onClick={() => setIsSearching(true)}>
                  Select file or symbol...
                  {template(svgSelect)()}
                </button>
              )
        }
      ></Dynamic>

      <Popover signal={[isSearching, setIsSearching]}>
        <input
          type="text"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              batch(() => {
                setValue("");
                setIsSearching(false);
              });
            }
          }}
          placeholder="Search file or symbol..."
        ></input>

        <div class="option-list">
          <Suspense fallback={<Spinner />}>
            <Show
              when={filtered()?.length}
              fallback={<div class="prompt">No result</div>}
            >
              <VList
                data={filtered()!}
                style={{
                  height: `calc(${filtered()!.length} * var(--option-height))`,
                }}
              >
                {(option) => (
                  <Option
                    option={option}
                    onClick={(o) => {
                      batch(() => {
                        setSelectedElem(
                          document.querySelector<SVGElement>(`[id="${o.id}"]`)!
                        );
                        setIsSearching(false);
                      });
                    }}
                  />
                )}
              </VList>
            </Show>
          </Suspense>
        </div>
      </Popover>
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
      <span class="kind">{option.kind ?? ""}</span>
      <div class="label">{option.label}</div>
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
    label: e.querySelector(".title")!.firstElementChild!.textContent!.trim(),
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
