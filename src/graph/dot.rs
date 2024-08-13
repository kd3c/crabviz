use {
    super::EdgeCssClass,
    crate::{
        graph::{Cell, Edge, Subgraph, TableNode},
        types::SymbolKind,
    },
    enumset::EnumSet,
    std::iter,
};

pub(crate) fn escape_html(s: &str) -> String {
    s.replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
}
const EMPTY_STRING: String = String::new();

pub(crate) struct Dot;

impl Dot {
    pub fn generate_dot_source<'a, T, E>(
        tables: T,
        // nodes: &[Node],
        edges: E,
        subgraphs: &[Subgraph],
    ) -> String
    where
        T: Iterator<Item = &'a TableNode>,
        E: Iterator<Item = Edge>,
    {
        let tables = tables
            .map(|table| {
                format!(
                    r#"
    "{id}" [id="{id}", label=<
        <TABLE BORDER="0" CELLBORDER="1" CELLSPACING="8" CELLPADDING="4">
        <TR><TD WIDTH="230" BORDER="0" CELLPADDING="6" HREF="{path};{id}">{title}</TD></TR>
        {cells}
        <TR><TD CELLSPACING="0" HEIGHT="1" WIDTH="1" FIXEDSIZE="TRUE" STYLE="invis"></TD></TR>
        </TABLE>
    >];
                    "#,
                    id = table.id,
                    path = table.path.to_str().unwrap(),
                    title = table.path.file_name().unwrap().to_str().unwrap(),
                    cells = table
                        .cells
                        .iter()
                        .map(|node| Dot::process_cell(table.id, node))
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        format!(
            r#"
digraph {{
    graph [
        rankdir = "LR"
        ranksep = 2.0
        fontname = "Arial"
    ];
    node [
        fontsize = "16"
        fontname = "Arial"
        shape = "plaintext"
        style = "rounded, filled"
    ];
    edge [
        label = " "
    ];

    {}

    {}

    {}
}}
            "#,
            tables,
            Dot::clusters(subgraphs),
            Dot::process_edges(edges),
        )
    }

    fn process_cell(table_id: u32, cell: &Cell) -> String {
        let styles = [
            cell.style
                .border
                .map_or(String::new(), |b| format!(r#"BORDER="{}""#, b)),
            cell.style
                .rounded
                .then_some(r#"STYLE="ROUNDED""#.to_string())
                .unwrap_or(String::new()),
        ]
        .join(" ");

        let title = format!(
            "{}{}",
            cell.style
                .icon
                .map(|c| format!("<B>{}</B>  ", c))
                .unwrap_or(EMPTY_STRING),
            escape_html(&cell.title)
        );
        let port = format!("{}_{}", cell.range.start.line, cell.range.start.character);
        let href = format!(r#"HREF="{}""#, cell.kind as u8 - SymbolKind::File as u8 + 1);

        if cell.children.is_empty() {
            format!(
                r#"     <TR><TD PORT="{port}" ID="{table_id}:{port}" {styles} {href}>{title}</TD></TR>"#,
            )
        } else {
            let (cell_styles, table_styles) = (r#"BORDER="0""#.to_string(), styles);

            let dot_cell = format!(
                r#"     <TR><TD PORT="{port}" {cell_styles} {href}>{title}</TD></TR>"#,
                href = EMPTY_STRING,
            );

            format!(
                r#"
            <TR><TD BORDER="0" CELLPADDING="0">
            <TABLE ID="{table_id}:{port}" CELLSPACING="8" CELLPADDING="4" CELLBORDER="1" {table_styles} BGCOLOR="green" {href}>
            {}
            </TABLE>
            </TD></TR>
            "#,
                iter::once(dot_cell)
                    .chain(
                        cell.children
                            .iter()
                            .map(|item| Dot::process_cell(table_id, item))
                    )
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
    }

    fn process_edges<E>(edges: E) -> String
    where
        E: Iterator<Item = Edge>,
    {
        edges
            .map(|e| {
                format!(
                    r#"{f0}:"{f1}_{f2}" -> {t0}:"{t1}_{t2}" [id="{f0}-{f0}:{f1}_{f2}-{t0}-{t0}:{t1}_{t2}", {classes}];"#,
                    f0 = e.from.0,
                    f1 = e.from.1.line,
                    f2 = e.from.1.character,
                    t0 = e.to.0,
                    t1 = e.to.1.line,
                    t2 = e.to.1.character,
                    classes = Dot::css_classes(e.classes)
                )
            })
            .collect::<Vec<_>>()
            .join("\n    ")
    }

    fn clusters(subgraphs: &[Subgraph]) -> String {
        subgraphs
            .iter()
            .map(|subgraph| {
                format!(
                    r#"
        subgraph "cluster_{name}" {{
            label = "{name}";

            {nodes}

            {subgraph}
        }};
                    "#,
                    name = subgraph.title,
                    nodes = subgraph.nodes.join(" "),
                    subgraph = Dot::clusters(&subgraph.subgraphs),
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn css_classes(classes: EnumSet<EdgeCssClass>) -> String {
        if classes.is_empty() {
            "".to_string()
        } else {
            format!(
                r#"class="{}""#,
                classes
                    .iter()
                    .map(|c| c.to_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        }
    }
}
