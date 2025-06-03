use {
    super::lsp::{Position, Range, SymbolKind},
    serde::Serialize,
    serde_repr::Serialize_repr,
    std::hash::{Hash, Hasher},
};

#[derive(Debug, Serialize)]
pub struct Graph {
    pub files: Vec<File>,
    pub relations: Vec<Relation>,
}

#[derive(Debug, Serialize)]
pub struct File {
    pub id: u32,
    pub path: String,
    pub symbols: Vec<Symbol>,
}

#[derive(Debug, Serialize)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub range: Range,
    pub children: Vec<Symbol>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Relation {
    pub from: GlobalPosition,
    pub to: GlobalPosition,
    pub kind: RelationKind,
}

impl Hash for Relation {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.from.hash(state);
        self.to.hash(state);
    }
}

impl PartialEq for Relation {
    fn eq(&self, other: &Self) -> bool {
        self.from == other.from && self.to == other.to
    }
}

impl Eq for Relation {}

#[derive(Debug, Clone, Serialize_repr)]
#[repr(u8)]
pub enum RelationKind {
    Call,
    Impl,
    Inherit,
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalPosition {
    pub file_id: u32,
    pub line: u32,
    pub character: u32,
}

impl GlobalPosition {
    pub fn new(file_id: u32, position: Position) -> Self {
        Self {
            file_id,
            line: position.line,
            character: position.character,
        }
    }
}
