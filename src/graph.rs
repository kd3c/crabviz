use {
    enumset::{EnumSet, EnumSetType},
    std::{
        hash::{Hash, Hasher},
        path::PathBuf,
    },
};

pub mod dot;

pub trait GenerateSVG {
    fn generate_svg(
        &self,
        tables: &[TableNode],
        // nodes: &[Node],
        edges: &[Edge],
        subgraphs: &[Subgraph],
    ) -> String;
}

#[derive(Debug, Clone)]
pub struct Edge {
    // (file_id, line, character)
    pub from: (u32, u32, u32),
    pub to: (u32, u32, u32),
    pub classes: EnumSet<EdgeCssClass>,
}

impl Hash for Edge {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.from.hash(state);
        self.to.hash(state);
    }
}

impl PartialEq for Edge {
    fn eq(&self, other: &Self) -> bool {
        self.from == other.from && self.to == other.to
    }
}

impl Eq for Edge {}

#[derive(Debug)]
pub struct Cell {
    pub range_start: (u32, u32),
    pub range_end: (u32, u32),
    pub kind: u8,
    pub title: String,
    pub style: Style,
    pub children: Vec<Cell>,
}

#[derive(Debug)]
pub struct TableNode {
    pub id: u32,
    pub path: PathBuf,
    pub cells: Vec<Cell>,
}

#[derive(Debug)]
pub struct Subgraph {
    pub title: String,
    pub nodes: Vec<String>,
    pub subgraphs: Vec<Subgraph>,
}

#[derive(Debug, Default)]
pub struct Style {
    pub rounded: bool,
    pub border: Option<u8>,
    pub icon: Option<char>,
}

#[derive(EnumSetType, Debug)]
pub enum EdgeCssClass {
    Impl,
}

impl EdgeCssClass {
    pub fn to_str(&self) -> &'static str {
        match self {
            EdgeCssClass::Impl => "impl",
        }
    }
}
