#[cfg(feature = "wasm")]
mod wasm;
#[cfg(feature = "wasm")]
pub use wasm::{set_panic_hook, GraphGeneratorWasm};

#[cfg(test)]
mod tests;

use {
    crate::{
        graph::{dot::Dot, Cell, Edge, EdgeCssClass, Subgraph, TableNode},
        lang,
        types::{
            CallHierarchyIncomingCall, CallHierarchyItem, CallHierarchyOutgoingCall,
            DocumentSymbol, Location, Position, SymbolKind, SymbolLocation,
        },
    },
    enumset::EnumSet,
    std::{
        cell::RefCell,
        collections::{hash_map::Entry, BTreeMap, HashMap, HashSet},
        path::{Path, PathBuf},
    },
};

pub struct GraphGenerator {
    // TODO: use a trie map to store files
    root: String,
    next_file_id: u32,

    lang: Box<dyn lang::Language>,
    files: HashMap<String, TableNode>,

    incoming_calls: HashMap<SymbolLocation, Vec<CallHierarchyIncomingCall>>,
    outgoing_calls: HashMap<SymbolLocation, Vec<CallHierarchyOutgoingCall>>,
    interfaces: HashMap<SymbolLocation, Vec<SymbolLocation>>,

    highlights: HashMap<u32, HashSet<(u32, u32)>>,
}

impl GraphGenerator {
    pub fn new(root: String, lang: &str) -> Self {
        Self {
            root,
            next_file_id: 1,
            files: HashMap::new(),
            incoming_calls: HashMap::new(),
            outgoing_calls: HashMap::new(),
            interfaces: HashMap::new(),
            highlights: HashMap::new(),

            lang: lang::language_handler(lang),
        }
    }

    pub fn should_filter_out_file(&self, file_path: &str) -> bool {
        self.lang.should_filter_out_file(file_path)
    }

    pub fn add_file(&mut self, file_path: String, symbols: Vec<DocumentSymbol>) -> bool {
        if self.lang.should_filter_out_file(&file_path) {
            return false;
        }

        let path = PathBuf::from(&file_path);

        match self.files.entry(file_path) {
            Entry::Vacant(entry) => {
                let file = TableNode {
                    id: self.next_file_id,
                    path,
                    cells: self.lang.symbols_repr(&symbols),
                };
                entry.insert(file);
                self.next_file_id += 1;
            }
            Entry::Occupied(_) => return false,
        }

        return true;
    }

    // TODO: graph database
    pub fn add_incoming_calls(
        &mut self,
        file_path: String,
        position: Position,
        calls: Vec<CallHierarchyIncomingCall>,
    ) {
        let location = SymbolLocation::new(file_path, position);
        self.incoming_calls.insert(location, calls);
    }

    pub fn add_outgoing_calls(
        &mut self,
        file_path: String,
        position: Position,
        calls: Vec<CallHierarchyOutgoingCall>,
    ) {
        let location = SymbolLocation::new(file_path, position);
        self.outgoing_calls.insert(location, calls);
    }

    pub fn highlight(&mut self, file_path: String, position: Position) {
        let file_id = match self.files.get(&file_path) {
            None => return,
            Some(file) => file.id,
        };

        let cell_pos = (position.line, position.character);

        match self.highlights.entry(file_id) {
            Entry::Vacant(entry) => {
                let mut set = HashSet::new();
                set.insert(cell_pos);

                entry.insert(set);
            }
            Entry::Occupied(mut entry) => {
                entry.get_mut().insert(cell_pos);
            }
        }
    }

    pub fn add_interface_implementations(
        &mut self,
        file_path: String,
        position: Position,
        locations: Vec<Location>,
    ) {
        let location = SymbolLocation::new(file_path, position);
        let implementations = locations
            .into_iter()
            .map(|location| SymbolLocation::new(location.uri.path, location.range.start))
            .collect();
        self.interfaces.insert(location, implementations);
    }

    pub fn generate_dot_source(&self) -> String {
        let mut cell_ids = HashSet::new();
        self.files
            .iter()
            .flat_map(|(_, tbl)| tbl.cells.iter().map(|cell| (tbl.id, cell)))
            .for_each(|(tid, cell)| self.collect_cell_ids(tid, cell, &mut cell_ids));
        let cell_ids_ref = &cell_ids;

        let inserted_symbols = RefCell::new(HashSet::new());
        let inserted_symbols_ref = &inserted_symbols;

        let incoming_calls = self
            .incoming_calls
            .iter()
            .filter_map(|(callee, callers)| {
                let to = callee.location_id(&self.files)?;

                cell_ids.contains(&to).then_some((to, callers))
            })
            .flat_map(|(to, calls)| {
                calls.into_iter().filter_map(move |call| {
                    let from = call.from.location_id(&self.files)?;

                    // incoming calls may start from nested functions, which may not be included in file symbols in some lsp server implementations.
                    // in that case, we add the missing nested symbol to the symbol list.
                    // another approach would be to modify edges to make them start from the outter functions, which is not so accurate

                    (cell_ids_ref.contains(&from)
                        || inserted_symbols_ref.borrow().contains(&from)
                        || {
                            let file = self.files.get(&call.from.uri.path)? as *const TableNode;

                            let updated = unsafe {
                                self.try_insert_symbol(
                                    &call.from,
                                    file.cast_mut().as_mut().unwrap(),
                                )
                            };

                            if updated {
                                inserted_symbols_ref.borrow_mut().insert(from);
                            }
                            updated
                        })
                    .then_some(Edge {
                        from,
                        to,
                        classes: EnumSet::new(),
                    })
                })
            });

        let outgoing_calls = self
            .outgoing_calls
            .iter()
            .filter_map(|(caller, callees)| {
                let from = caller.location_id(&self.files)?;

                cell_ids.contains(&from).then_some((from, callees))
            })
            .flat_map(|(from, callees)| {
                callees.into_iter().filter_map(move |call| {
                    let to = call.to.location_id(&self.files)?;

                    cell_ids_ref.contains(&to).then_some(Edge {
                        from,
                        to,
                        classes: EnumSet::new(),
                    })
                })
            });

        let implementations = self
            .interfaces
            .iter()
            .filter_map(|(interface, implementations)| {
                let to = interface.location_id(&self.files)?;

                cell_ids.contains(&to).then_some((to, implementations))
            })
            .flat_map(|(to, implementations)| {
                implementations.into_iter().filter_map(move |location| {
                    let from = location.location_id(&self.files)?;

                    cell_ids_ref.contains(&&from).then_some(Edge {
                        from,
                        to,
                        classes: EdgeCssClass::Impl.into(),
                    })
                })
            });

        let edges = incoming_calls
            .chain(outgoing_calls)
            .chain(implementations)
            .collect::<HashSet<_>>();

        let subgraphs = self.subgraphs(self.files.iter().map(|(_, f)| f));

        Dot::generate_dot_source(self.files.values(), edges.into_iter(), &subgraphs)
    }

    fn subgraphs<'a, I>(&'a self, files: I) -> Vec<Subgraph>
    where
        I: Iterator<Item = &'a TableNode>,
    {
        let mut dirs = BTreeMap::new();
        for f in files {
            let parent = f.path.parent().unwrap();
            dirs.entry(parent)
                .or_insert(Vec::new())
                .push(f.path.clone());
        }

        let mut subgraphs: Vec<Subgraph> = vec![];

        dirs.iter().for_each(|(dir, files)| {
            let nodes = files
                .iter()
                .map(|path| {
                    self.files
                        .get(path.to_str().unwrap())
                        .unwrap()
                        .id
                        .to_string()
                })
                .collect::<Vec<_>>();

            let dir = dir.strip_prefix(&self.root).unwrap_or(dir);
            self.add_subgraph(dir, nodes, &mut subgraphs);
        });

        subgraphs
    }

    fn add_subgraph<'a, 'b, 'c>(
        &'a self,
        dir: &'b Path,
        nodes: Vec<String>,
        subgraphs: &'c mut Vec<Subgraph>,
    ) {
        let ancestor = subgraphs.iter_mut().find(|g| dir.starts_with(&g.title));

        match ancestor {
            None => subgraphs.push(Subgraph {
                title: dir.to_str().unwrap().into(),
                nodes,
                subgraphs: vec![],
            }),
            Some(ancestor) => {
                let dir = dir.strip_prefix(&ancestor.title).unwrap();
                self.add_subgraph(dir, nodes, &mut ancestor.subgraphs);
            }
        }
    }

    fn collect_cell_ids(&self, table_id: u32, cell: &Cell, ids: &mut HashSet<(u32, Position)>) {
        ids.insert((table_id, cell.range.start));
        cell.children
            .iter()
            .for_each(|child| self.collect_cell_ids(table_id, child, ids));
    }

    fn try_insert_symbol(&self, item: &CallHierarchyItem, file: &mut TableNode) -> bool {
        let mut cells = &mut file.cells;
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
                    Cell {
                        range: item.selection_range,
                        kind: item.kind,
                        title: item.name.clone(),
                        style: self.lang.symbol_style(&item.kind),
                        children,
                    },
                );
            }

            return is_subsymbol;
        }
    }
}

trait LocationId {
    fn location_id(&self, files: &HashMap<String, TableNode>) -> Option<(u32, Position)>;
}

impl LocationId for SymbolLocation {
    fn location_id(&self, files: &HashMap<String, TableNode>) -> Option<(u32, Position)> {
        Some((files.get(&self.path)?.id, self.position))
    }
}

impl LocationId for CallHierarchyItem {
    fn location_id(&self, files: &HashMap<String, TableNode>) -> Option<(u32, Position)> {
        Some((files.get(&self.uri.path)?.id, self.selection_range.start))
    }
}
