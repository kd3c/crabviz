mod lsp;

pub(crate) use lsp::*;

#[derive(Hash, PartialEq, Eq, Clone)]
pub struct SymbolLocation {
    pub path: String,
    pub position: Position,
}

impl SymbolLocation {
    pub fn new(path: String, position: Position) -> Self {
        Self { path, position }
    }
}
