//! PIPELINE statement handler — sequential stage execution with timeout enforcement.
//!
//! Phase 1 semantics:
//! - Stages execute in order
//! - Stage results are concatenated into the pipeline's `data` vector
//! - Any stage error causes fail-fast with the stage index in the message
//! - TIMEOUT applies to the entire pipeline execution (cumulative)
//! - Write statements (STORE/UPDATE/FORGET/LINK/REFLECT) are rejected at each stage
//! - Nested PIPELINE is not supported — dispatch rejects it

use std::time::Instant;

use aql_parser::ast::{PipelineStmt, Statement};
use rusqlite::Connection;
use serde_json::Value as JsonValue;

use crate::error::AqlResult;
use crate::result::QueryResult;

pub fn execute(conn: &Connection, stmt: &PipelineStmt) -> AqlResult<QueryResult> {
    let start = Instant::now();
    let timeout_ms = stmt.timeout.map(|d| d.as_millis());

    let mut collected_data: Vec<JsonValue> = Vec::new();
    let mut collected_warnings: Vec<String> = Vec::new();
    let mut stages_completed: usize = 0;

    for (i, stage_stmt) in stmt.stages.iter().enumerate() {
        // Timeout check before each stage
        if let Some(budget_ms) = timeout_ms {
            if start.elapsed().as_millis() > budget_ms {
                let mut result = QueryResult::error(
                    "Pipeline",
                    format!(
                        "pipeline '{}' timed out after {:?} at stage {}",
                        stmt.name,
                        stmt.timeout,
                        i + 1
                    ),
                );
                result.pipeline_stages = Some(stages_completed);
                result.data = collected_data;
                result.count = result.data.len();
                return Ok(result);
            }
        }

        // Dispatch the stage using our in-module dispatcher (avoids a circular
        // dependency with Executor::dispatch)
        let stage_result = dispatch_stage(conn, stage_stmt)?;

        if !stage_result.success {
            let mut result = QueryResult::error(
                "Pipeline",
                format!(
                    "pipeline failed at stage {}: {}",
                    i + 1,
                    stage_result.error.as_deref().unwrap_or("unknown error")
                ),
            );
            result.pipeline_stages = Some(stages_completed);
            result.data = collected_data;
            result.count = result.data.len();
            return Ok(result);
        }

        collected_data.extend(stage_result.data);
        collected_warnings.extend(stage_result.warnings);
        stages_completed += 1;
    }

    let mut result = QueryResult::success("Pipeline", collected_data);
    result.warnings = collected_warnings;
    result.pipeline_stages = Some(stages_completed);
    Ok(result)
}

/// In-module dispatch that mirrors `Executor::dispatch`. Kept separate to avoid
/// a circular dependency between `executor.rs` and `statements/pipeline.rs`.
/// Must be kept in sync with Executor::dispatch when new statement types are added.
fn dispatch_stage(conn: &Connection, stmt: &Statement) -> AqlResult<QueryResult> {
    match stmt {
        Statement::Recall(r) => crate::statements::recall::execute(conn, r),
        Statement::Lookup(l) => crate::statements::lookup::execute(conn, l),
        Statement::Scan(s) => crate::statements::scan::execute(conn, s),
        Statement::Load(l) => crate::statements::load::execute(conn, l),
        Statement::Store(_)
        | Statement::Update(_)
        | Statement::Forget(_)
        | Statement::Link(_)
        | Statement::Reflect(_) => Ok(crate::statements::write_reject::reject(stmt)),
        Statement::Pipeline(_) => Ok(QueryResult::error(
            "Pipeline",
            "nested PIPELINE is not supported",
        )),
    }
}
