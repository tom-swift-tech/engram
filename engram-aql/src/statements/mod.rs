//! Statement handlers — one module per AQL statement type.

pub mod graph;
pub mod load;
pub mod lookup;
pub mod pipeline;
pub mod recall;
pub mod scan;
pub mod write_delegate;
pub mod write_reject;

use aql_parser::ast::Statement;

use crate::error::AqlResult;
use crate::exec_ctx::ExecCtx;
use crate::result::QueryResult;

/// Dispatch a single AQL statement to its handler.
///
/// This is the shared dispatcher used by both `Executor::query_with_vars` and
/// `pipeline::execute`. Extracting it here keeps a single source of truth
/// for which statement maps to which handler — adding a new statement
/// type requires updating only this function.
///
/// Handlers that don't need `vars` or `bridge` receive `ctx.conn` directly;
/// `recall` and the write handlers take the full `ctx` (vars + bridge).
pub(crate) fn dispatch(ctx: &ExecCtx<'_>, stmt: &Statement) -> AqlResult<QueryResult> {
    match stmt {
        Statement::Recall(r) => recall::execute(ctx, r),
        Statement::Lookup(l) => lookup::execute(ctx.conn, l),
        Statement::Scan(s) => scan::execute(ctx.conn, s),
        Statement::Load(l) => load::execute(ctx.conn, l),

        // Writes are delegated to the canonical TS retain pipeline over the
        // bridge (Phase 2b). LINK has no canonical TS surface — still rejected.
        Statement::Store(s) => write_delegate::store(ctx, s),
        Statement::Update(u) => write_delegate::update(ctx, u),
        Statement::Forget(f) => write_delegate::forget(ctx, f),
        Statement::Reflect(r) => write_delegate::reflect(ctx, r),
        Statement::Link(_) => Ok(write_reject::reject(stmt)),

        // Pipeline runs via the pipeline handler. Nested pipelines are
        // allowed by this dispatcher but the pipeline handler rejects them
        // (see pipeline::execute).
        Statement::Pipeline(p) => pipeline::execute(ctx, p),
    }
}
