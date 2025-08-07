mod go;
mod jsts;
mod rust;

use {
    self::{go::Go, jsts::Jsts, rust::Rust},
    crate::types::lsp::{DocumentSymbol, SymbolKind},
};

pub(crate) trait Language {
    fn should_filter_out_file(&self, _file: &str) -> bool {
        false
    }

    fn filter_symbol(&self, symbol: &DocumentSymbol, parent: Option<&DocumentSymbol>) -> bool {
        match symbol.kind {
            SymbolKind::Constant | SymbolKind::Variable | SymbolKind::EnumMember => false,
            SymbolKind::Field | SymbolKind::Property => {
                parent.is_some_and(|s| matches!(s.kind, SymbolKind::Interface))
            }
            _ => true,
        }
    }

    // fn handle_unrecognized_functions(&self, funcs: Vec<&DocumentSymbol>);
}

pub struct DefaultLang;
impl Language for DefaultLang {}

pub(self) const DEFAULT_LANG: DefaultLang = DefaultLang {};

pub(crate) fn language_handler(lang: &str) -> Box<dyn Language + Sync + Send> {
    match lang {
        "Go" => Box::new(Go),
        "Rust" => Box::new(Rust),
        "JavaScript" | "TypeScript" | "JavaScript JSX" | "TypeScript JSX" => Box::new(Jsts),
        _ => Box::new(DEFAULT_LANG),
    }
}
