#[cfg(feature = "wasm")]
mod wasm;
#[cfg(feature = "wasm")]
pub use wasm::{set_panic_hook, GraphGeneratorWasm};

#[cfg(test)]
mod tests;

use {
    crate::{
        lang,
        types::{
            graph::{File, GlobalPosition, Graph, Relation, RelationKind, Symbol},
            lsp::{
                CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall,
                DocumentSymbol, Location, Position, SymbolKind,
            },
        },
    },
    std::{
        cell::RefCell,
        collections::{hash_map::Entry, HashMap, HashSet},
    },
};

pub struct GraphGenerator {
    lang: Box<dyn lang::Language>,

    file_id_map: HashMap<String, u32>,
    files: HashMap<String, Vec<DocumentSymbol>>,
    incoming_calls: HashMap<GlobalPosition, Vec<CallHierarchyIncomingCall>>,
    outgoing_calls: HashMap<GlobalPosition, Vec<CallHierarchyOutgoingCall>>,
    interfaces: HashMap<GlobalPosition, Vec<GlobalPosition>>,

    filter: bool,
}

impl GraphGenerator {
    pub fn new(lang: &str, filter: bool) -> Self {
        Self {
            lang: lang::language_handler(lang),

            file_id_map: HashMap::new(),
            files: HashMap::new(),
            incoming_calls: HashMap::new(),
            outgoing_calls: HashMap::new(),
            interfaces: HashMap::new(),

            filter,
        }
    }

    fn alloc_file_id(&mut self, path: String) -> u32 {
        let len = self.file_id_map.len();
        self.file_id_map
            .entry(path)
            .or_insert(len as u32 + 1)
            .to_owned()
    }

    pub fn should_filter_out_file(&self, path: &str) -> bool {
        self.lang.should_filter_out_file(path)
    }

    pub fn add_file(&mut self, path: String, symbols: Vec<DocumentSymbol>) -> bool {
        if self.lang.should_filter_out_file(&path) {
            return false;
        }

        match self.files.entry(path) {
            Entry::Vacant(entry) => {
                let key = entry.key().clone();
                entry.insert(symbols);
                self.alloc_file_id(key);
            }
            Entry::Occupied(_) => return false,
        }

        return true;
    }

    // TODO: graph database
    pub fn add_incoming_calls(
        &mut self,
        path: String,
        position: Position,
        calls: Vec<CallHierarchyIncomingCall>,
    ) {
        let location = GlobalPosition::new(self.alloc_file_id(path), position);
        self.incoming_calls.insert(location, calls);
    }

    pub fn add_outgoing_calls(
        &mut self,
        path: String,
        position: Position,
        calls: Vec<CallHierarchyOutgoingCall>,
    ) {
        let location = GlobalPosition::new(self.alloc_file_id(path), position);
        self.outgoing_calls.insert(location, calls);
    }

    pub fn add_interface_implementations(
        &mut self,
        path: String,
        position: Position,
        locations: Vec<Location>,
    ) {
        let location = GlobalPosition::new(self.alloc_file_id(path), position);
        let implementations = locations
            .into_iter()
            .map(|location| {
                GlobalPosition::new(self.alloc_file_id(location.uri.path), location.range.start)
            })
            .collect();
        self.interfaces.insert(location, implementations);
    }

    pub fn gen_graph(&self) -> Graph {
        let (files, symbols) = self.collect_files_and_symbols();
        let files_ref = &files;
        let symbols_ref = &symbols;

        let inserted_symbols = RefCell::new(HashSet::new());
        let inserted_symbols_ref = &inserted_symbols;

        let incoming_calls = self
            .incoming_calls
            .iter()
            .filter_map(|(callee, callers)| symbols.contains(&callee).then_some((callee, callers)))
            .flat_map(|(to, calls)| {
                calls.into_iter().filter_map(move |call| {
                    let from = self.call_item_global_location(&call.from)?;

                    // incoming calls may start from nested functions, which may not be included in file symbols in some lsp server implementations.
                    // in that case, we add the missing nested symbol to the symbol list.
                    // another approach would be to modify edges to make them start from the outter functions, which is not so accurate

                    (symbols_ref.contains(&from)
                        || inserted_symbols_ref.borrow().contains(&from)
                        || {
                            let id = *self.file_id_map.get(&call.from.uri.path)?;
                            let node = files_ref.get(id as usize - 1)? as *const File;

                            let updated = self.try_insert_symbol(&call.from, unsafe {
                                node.cast_mut().as_mut().unwrap()
                            });

                            if updated {
                                inserted_symbols_ref.borrow_mut().insert(from);
                            }
                            updated
                        })
                    .then_some(Relation {
                        from,
                        to: to.to_owned(),
                        kind: RelationKind::Call,
                    })
                })
            });

        let outgoing_calls = self
            .outgoing_calls
            .iter()
            .filter_map(|(caller, callees)| {
                symbols_ref.contains(&caller).then_some((caller, callees))
            })
            .flat_map(|(from, callees)| {
                callees.into_iter().filter_map(move |call| {
                    let to = self.call_item_global_location(&call.to)?;

                    symbols_ref.contains(&to).then_some(Relation {
                        from: from.to_owned(),
                        to,
                        kind: RelationKind::Call,
                    })
                })
            });

        let implementations = self
            .interfaces
            .iter()
            .filter_map(|(interface, implementations)| {
                symbols_ref
                    .contains(&interface)
                    .then_some((interface, implementations))
            })
            .flat_map(|(to, implementations)| {
                implementations.into_iter().filter_map(move |location| {
                    symbols_ref.contains(location).then_some(Relation {
                        from: location.to_owned(),
                        to: to.to_owned(),
                        kind: RelationKind::Impl,
                    })
                })
            });

        let edges = incoming_calls
            .chain(outgoing_calls)
            .chain(implementations)
            .collect::<HashSet<_>>();

        Graph {
            files,
            relations: edges.into_iter().collect(),
        }
    }

    fn collect_files_and_symbols(&self) -> (Vec<File>, HashSet<GlobalPosition>) {
        let mut all_symbols = HashSet::new();
        let files = self
            .files
            .iter()
            .map(|(p, symbols)| {
                let symbols = symbols
                    .iter()
                    .filter_map(|s| {
                        self.convert_symbol(self.file_id_map[p], s, None, &mut all_symbols)
                    })
                    .collect();

                File {
                    id: self.file_id_map[p],
                    path: p.clone(),
                    symbols,
                }
            })
            .collect::<Vec<_>>();

        (files, all_symbols)
    }

    fn convert_symbol(
        &self,
        file_id: u32,
        symbol: &DocumentSymbol,
        parent: Option<&DocumentSymbol>,
        all_symbols: &mut HashSet<GlobalPosition>,
    ) -> Option<Symbol> {
        if self.filter && !self.lang.filter_symbol(symbol, parent) {
            return Option::None;
        }

        all_symbols.insert(GlobalPosition::new(file_id, symbol.selection_range.start));

        let children = symbol
            .children
            .iter()
            .filter_map(|child| self.convert_symbol(file_id, child, Some(symbol), all_symbols))
            .collect();

        Some(Symbol {
            range: symbol.selection_range,
            kind: symbol.kind,
            name: symbol.name.clone(),
            children,
        })
    }

    fn try_insert_symbol(&self, item: &CallHierarchyItem, node: &mut File) -> bool {
        let mut cells = &mut node.symbols;
        let mut is_subsymbol = false;

        loop {
            let i = match cells.binary_search_by_key(&item.range.start, |cell| cell.range.start) {
                Ok(_) => return true, // should be unreachable
                Err(i) => i,
            };

            if i > 0 {
                let cell = cells.get(i - 1).unwrap();

                if cell.range.end > item.range.end {
                    // we just deal with nested functions here
                    if !matches!(cell.kind, SymbolKind::Function | SymbolKind::Method) {
                        return false;
                    }
                    is_subsymbol = true;

                    // fight the borrow checker
                    cells = &mut cells.get_mut(i - 1).unwrap().children;

                    continue;
                }
            }

            if is_subsymbol {
                let mut children = vec![];

                if let Some(next_cell) = cells.get(i) {
                    if next_cell.range.start > item.range.start
                        && next_cell.range.end < item.range.end
                    {
                        let next_cell = cells.remove(i);
                        children.push(next_cell);
                    }
                }

                cells.insert(
                    i,
                    Symbol {
                        name: item.name.clone(),
                        kind: item.kind,
                        range: item.selection_range,
                        children,
                    },
                );
            }

            return is_subsymbol;
        }
    }

    fn call_item_global_location(&self, item: &CallHierarchyItem) -> Option<GlobalPosition> {
        Some(GlobalPosition::new(
            *self.file_id_map.get(&item.uri.path)?,
            item.selection_range.start,
        ))
    }
}
