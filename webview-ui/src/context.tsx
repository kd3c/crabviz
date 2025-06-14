import { createContext, createSignal, useContext } from "solid-js";

export enum ScaleOption {
  ZoomIn,
  ZoomOut,
  Reset,
}

export enum ExportOption {
  Svg,
  Html
}

const makeAppContext = () => {
  const [collapse, setCollapse] = createSignal(false);

  const [items, setItems] = createSignal<
    | {
        files: Map<string, SVGElement>;
        symbols: SVGElement[];
      }
    | undefined
  >(undefined);

  const [selectedElem, setSelectedElem] = createSignal<SVGElement | null>(null);

  const [scaleOpt, setScaleOpt] = createSignal(ScaleOption.Reset, {
    equals: false,
  });

  const [exportOpt, setExportOpt] = createSignal(ExportOption.Svg, { equals: false });

  return [
    { collapse, items, selectedElem, scaleOpt, exportOpt },
    { setCollapse, setItems, setSelectedElem, setScaleOpt, setExportOpt },
  ] as const;
  // `as const` forces tuple type inference
};

type AppContextType = ReturnType<typeof makeAppContext>;
export const AppContext = createContext<AppContextType>(makeAppContext());

export const useAppContext = () => useContext(AppContext);
