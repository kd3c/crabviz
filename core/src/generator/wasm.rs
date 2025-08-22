use {
    super::GraphGenerator,
    crate::types::lsp::{
        CallHierarchyIncomingCall, CallHierarchyOutgoingCall, DocumentSymbol, Location, Position,
    },
    std::cell::RefCell,
    wasm_bindgen::prelude::*,
};

#[wasm_bindgen]
pub fn set_panic_hook() {
    // When the `console_error_panic_hook` feature is enabled, we can call the
    // `set_panic_hook` function at least once during initialization, and then
    // we will get better error messages if our code ever panics.
    //
    // For more details see
    // https://github.com/rustwasm/console_error_panic_hook#readme
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
extern "C" {
    // Use `js_namespace` here to bind `console.log(..)` instead of just
    // `log(..)`
    #[wasm_bindgen(js_namespace = console)]
    pub(crate) fn log(s: String);
}

#[wasm_bindgen(js_name = GraphGenerator)]
pub struct GraphGeneratorWasm {
    inner: RefCell<GraphGenerator>,
}

#[wasm_bindgen(js_class = GraphGenerator)]
impl GraphGeneratorWasm {
    #[wasm_bindgen(constructor)]
    pub fn new(lang: String, filter: bool) -> Self {
        Self {
            inner: RefCell::new(GraphGenerator::new(&lang, filter)),
        }
    }

    pub fn should_filter_out_file(&self, path: String) -> bool {
        self.inner.borrow().should_filter_out_file(&path)
    }

    pub fn add_file(&self, path: String, symbols: JsValue) -> bool {
        let symbols = serde_wasm_bindgen::from_value::<Vec<DocumentSymbol>>(symbols).unwrap();

        self.inner.borrow_mut().add_file(path, symbols)
    }

    pub fn add_incoming_calls(&self, path: String, position: JsValue, calls: JsValue) {
        let position = serde_wasm_bindgen::from_value::<Position>(position).unwrap();
        let calls =
            serde_wasm_bindgen::from_value::<Vec<CallHierarchyIncomingCall>>(calls).unwrap();

        self.inner
            .borrow_mut()
            .add_incoming_calls(path, position, calls);
    }

    pub fn add_outgoing_calls(&self, path: String, position: JsValue, calls: JsValue) {
        let position = serde_wasm_bindgen::from_value::<Position>(position).unwrap();
        let calls =
            serde_wasm_bindgen::from_value::<Vec<CallHierarchyOutgoingCall>>(calls).unwrap();

        self.inner
            .borrow_mut()
            .add_outgoing_calls(path, position, calls);
    }

    pub fn add_interface_implementations(
        &self,
        path: String,
        position: JsValue,
        locations: JsValue,
    ) {
        let position = serde_wasm_bindgen::from_value::<Position>(position).unwrap();
        let locations = serde_wasm_bindgen::from_value::<Vec<Location>>(locations).unwrap();

        self.inner
            .borrow_mut()
            .add_interface_implementations(path, position, locations);
    }

    pub fn gen_graph(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.inner.borrow().gen_graph()).unwrap()
    }
}
