//! PIPELINE statement handler — sequential stage execution with timeout enforcement.

use std::time::Instant;

use aql_parser::ast::{PipelineStmt, Statement};
use serde_json::Value as JsonValue;

use crate::error::AqlResult;
use crate::exec_ctx::ExecCtx;
use crate::result::QueryResult;

pub fn execute(ctx: &ExecCtx<'_>, stmt: &PipelineStmt) -> AqlResult<QueryResult> {
    let start = Instant::now();
    let timeout_ms = stmt.timeout.map(|d| d.as_millis());

    let mut collected_data: Vec<JsonValue> = Vec::new();
    let mut collected_warnings: Vec<String> = Vec::new();
    let mut stages_completed: usize = 0;

    for (i, stage_stmt) in stmt.stages.iter().enumerate() {
        // Timeout check before each stage
        if let Some(budget_ms) = timeout_ms {
            if start.elapsed().as_millis() >= budget_ms {
                return Ok(build_failure(
                    "Pipeline",
                    format!(
                        "pipeline '{}' timed out after {:?} at stage {}",
                        stmt.name,
                        stmt.timeout,
                        i + 1
                    ),
                    stages_completed,
                ));
            }
        }

        // Reject nested PIPELINE before it would recurse via the shared
        // dispatcher (which delegates Pipeline back to this handler).
        if matches!(stage_stmt, Statement::Pipeline(_)) {
            return Ok(build_failure(
                "Pipeline",
                format!(
                    "pipeline failed at stage {}: nested PIPELINE is not supported",
                    i + 1
                ),
                stages_completed,
            ));
        }

        // A stage's user-facing validation error (InvalidQuery) is reported as
        // a graceful stage failure with stage context, mirroring how
        // `Executor::query_with_vars` surfaces InvalidQuery. Genuine infra
        // errors (SQLite, I/O) still propagate as hard errors.
        let stage_result = match crate::statements::dispatch(ctx, stage_stmt) {
            Ok(r) => r,
            Err(crate::error::AqlError::InvalidQuery(msg)) => {
                return Ok(build_failure(
                    "Pipeline",
                    format!("pipeline failed at stage {}: {}", i + 1, msg),
                    stages_completed,
                ));
            }
            Err(e) => return Err(e),
        };

        if !stage_result.success {
            return Ok(build_failure(
                "Pipeline",
                format!(
                    "pipeline failed at stage {}: {}",
                    i + 1,
                    stage_result.error.as_deref().unwrap_or("unknown error")
                ),
                stages_completed,
            ));
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

/// Build a failed pipeline result with partial data CLEARED.
///
/// Fix 3: do not leak partial data on failure — consumers checking
/// `result.data.len() > 0` would otherwise be misled. The success flag is
/// the single source of truth, and data is empty on failure.
fn build_failure(statement: &str, message: String, stages_completed: usize) -> QueryResult {
    let mut result = QueryResult::error(statement, message);
    result.pipeline_stages = Some(stages_completed);
    result
}
