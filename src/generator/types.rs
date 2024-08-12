use {
    crate::lsp_types::Position,
    std::{fmt::Display, hash::Hash},
};

#[derive(Hash, PartialEq, Eq, Clone)]
pub struct SymbolLocation {
    pub path: String,
    pub line: u32,
    pub character: u32,
}

impl SymbolLocation {
    pub fn new(path: String, position: &Position) -> Self {
        Self {
            path,
            line: position.line,
            character: position.character,
        }
    }
}

impl Display for SymbolLocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, r#""{}":"{}_{}""#, self.path, self.line, self.character)
    }
}
