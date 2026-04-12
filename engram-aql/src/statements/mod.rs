//! Statement handlers — one module per AQL statement type.

pub mod graph;
pub mod load;
pub mod lookup;
pub mod pipeline;
pub mod recall;
pub mod scan;
pub mod write_reject;

use aql_parser::ast::Statement;
use rusqlite::Connection;

use crate::error::AqlResult;
use crate::result::QueryResult;

/// Dispatch a single AQL statement to its handler.
///
/// This is the shared dispatcher used by both `Executor::query` and
/// `pipeline::execute`. Extracting it here keeps a single source of truth
/// for which statement maps to which handler — adding a new statement
/// type requires updating only this function.
pub(crate) fn dispatch(conn: &Connection, stmt: &Statement) -> AqlResult<QueryResult> {
    match stmt {
        Statement::Recall(r) => recall::execute(conn, r),
        Statement::Lookup(l) => lookup::execute(conn, l),
        Statement::Scan(s) => scan::execute(conn, s),
        Statement::Load(l) => load::execute(conn, l),

        // Writes are rejected at dispatch time (Phase 1 read-only)
        Statement::Store(_)
        | Statement::Update(_)
        | Statement::Forget(_)
        | Statement::Link(_)
        | Statement::Reflect(_) => Ok(write_reject::reject(stmt)),

        // Pipeline runs via the pipeline handler. Nested pipelines are
        // allowed by this dispatcher but the pipeline handler rejects them
        // (see pipeline::execute).
        Statement::Pipeline(p) => pipeline::execute(conn, p),
    }
}
