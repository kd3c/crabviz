mod go;
mod rust;

use {
    self::{go::Go, rust::Rust},
    crate::{
        graph::{Cell, Style},
        types::{DocumentSymbol, SymbolKind},
    },
};

pub(crate) trait Language {
    fn should_filter_out_file(&self, _file: &str) -> bool {
        false
    }

    fn symbols_repr(&self, symbols: &[DocumentSymbol]) -> Vec<Cell> {
        symbols
            .iter()
            .filter(|symbol| self.filter_symbol(symbol))
            .map(|symbol| self.symbol_repr(symbol))
            .collect()
    }

    fn symbol_repr(&self, symbol: &DocumentSymbol) -> Cell {
        let children = symbol
            .children
            .iter()
            .filter(|s| symbol.kind == SymbolKind::Interface || self.filter_symbol(s))
            .map(|symbol| self.symbol_repr(symbol))
            .collect();

        Cell {
            range: symbol.selection_range,
            kind: symbol.kind,
            title: symbol.name.clone(),
            style: self.symbol_style(&symbol.kind),
            children,
        }
    }

    fn filter_symbol(&self, symbol: &DocumentSymbol) -> bool {
        match symbol.kind {
            SymbolKind::Constant
            | SymbolKind::Variable
            | SymbolKind::Field
            | SymbolKind::Property
            | SymbolKind::EnumMember => false,
            _ => true,
        }
    }

    fn symbol_style(&self, kind: &SymbolKind) -> Style {
        match kind {
            SymbolKind::Module => Style {
                rounded: true,
                ..Default::default()
            },
            SymbolKind::Function => Style {
                rounded: true,
                ..Default::default()
            },
            SymbolKind::Method => Style {
                rounded: true,
                ..Default::default()
            },
            SymbolKind::Constructor => Style {
                rounded: true,
                ..Default::default()
            },
            SymbolKind::Interface => Style {
                border: Some(0),
                rounded: true,
                ..Default::default()
            },
            SymbolKind::Enum => Style {
                icon: Some('E'),
                ..Default::default()
            },
            SymbolKind::Struct => Style {
                icon: Some('S'),
                ..Default::default()
            },
            SymbolKind::Class => Style {
                icon: Some('C'),
                ..Default::default()
            },
            SymbolKind::TypeParameter => Style {
                icon: Some('T'),
                ..Default::default()
            },
            SymbolKind::Field => Style {
                icon: Some('f'),
                ..Default::default()
            },
            SymbolKind::Property => Style {
                icon: Some('p'),
                ..Default::default()
            },
            _ => Style {
                rounded: true,
                ..Default::default()
            },
        }
    }

    // fn handle_unrecognized_functions(&self, funcs: Vec<&DocumentSymbol>);
}

pub struct DefaultLang;

impl Language for DefaultLang {}

pub(crate) fn language_handler(lang: &str) -> Box<dyn Language + Sync + Send> {
    match lang {
        "Go" => Box::new(Go),
        "Rust" => Box::new(Rust),
        _ => Box::new(DefaultLang {}),
    }
}
