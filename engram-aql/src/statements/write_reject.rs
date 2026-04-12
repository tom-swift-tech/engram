//! Rejection handler for write statements in Phase 1.

use aql_parser::ast::Statement;

use crate::result::QueryResult;

pub fn reject(stmt: &Statement) -> QueryResult {
    let (name, hint) = match stmt {
        Statement::Store(_) => (
            "Store",
            "STORE is not supported in engram-aql read-only mode. \
             Use `engram_retain` via the TypeScript MCP server.",
        ),
        Statement::Update(_) => (
            "Update",
            "UPDATE is not supported in engram-aql read-only mode. \
             Use `engram_supersede` via the TypeScript MCP server.",
        ),
        Statement::Forget(_) => (
            "Forget",
            "FORGET is not supported in engram-aql read-only mode. \
             Use `engram_forget` via the TypeScript MCP server.",
        ),
        Statement::Link(_) => (
            "Link",
            "LINK is not supported in Phase 1. Planned for Phase 2.",
        ),
        Statement::Reflect(_) => (
            "Reflect",
            "REFLECT requires LLM access and is not available in engram-aql. \
             Use `engram_reflect` via the TypeScript MCP server.",
        ),
        _ => ("Unknown", "statement type not recognized for rejection"),
    };

    QueryResult::error(name, hint)
}
