//! Rejection handler for `LINK`.
//!
//! As of Phase 2b, `STORE`/`UPDATE`/`FORGET`/`REFLECT` are delegated to the TS
//! retain pipeline (see `write_delegate`). `LINK` remains rejected: entities and
//! relations are extraction-derived, and there is no canonical TS tool for
//! authoring manual relations yet (see the spec's Open Questions).

use aql_parser::ast::Statement;

use crate::result::QueryResult;

pub fn reject(stmt: &Statement) -> QueryResult {
    let (name, hint) = match stmt {
        Statement::Link(_) => (
            "Link",
            "LINK is not supported: entities/relations are extraction-derived, and there is no \
             canonical TypeScript tool for manual relation authoring yet. Track this in the \
             engram-aql Phase 2 design (Open Questions).",
        ),
        _ => (
            "Unknown",
            "statement type not recognized for rejection (this is a bug — writes other than \
             LINK are delegated via write_delegate)",
        ),
    };

    QueryResult::error(name, hint)
}
