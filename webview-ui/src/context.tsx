import { createContext, createSignal, useContext } from "solid-js";

const makeAppContext = () => {
  const [items, setItems] = createSignal<
    | {
        files: Map<string, SVGElement>;
        symbols: SVGElement[];
      }
    | undefined
  >(undefined);

  const [selectedElem, setSelectedElem] = createSignal<SVGElement | undefined>(
    undefined
  );

  return [
    { items, selectedElem },
    { setItems, setSelectedElem },
  ] as const;
  // `as const` forces tuple type inference
};

type AppContextType = ReturnType<typeof makeAppContext>;
export const AppContext = createContext<AppContextType>(makeAppContext());

export const useAppContext = () => useContext(AppContext);
