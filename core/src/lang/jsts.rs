use {
    super::Language,
    crate::{
        lang::DEFAULT_LANG,
        types::lsp::{DocumentSymbol, SymbolKind},
    },
};

pub(crate) struct Jsts;

impl Language for Jsts {
    fn filter_symbol(&self, symbol: &DocumentSymbol, parent: Option<&DocumentSymbol>) -> bool {
        match symbol.kind {
            SymbolKind::Function => !symbol.name.ends_with(" callback"),
            _ => DEFAULT_LANG.filter_symbol(symbol, parent),
        }
    }
}
