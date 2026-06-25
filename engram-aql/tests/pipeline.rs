//! PIPELINE integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn pipeline_two_stages_returns_combined_results() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            "PIPELINE test TIMEOUT 10s RECALL FROM EPISODIC ALL LIMIT 2 | RECALL FROM SEMANTIC ALL LIMIT 2",
        )
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.statement, "Pipeline");
    assert_eq!(result.pipeline_stages, Some(2));
    // 2 from episodic + 2 from semantic = 4
    assert_eq!(result.count, 4);
}

#[test]
fn pipeline_single_stage_runs() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("PIPELINE p1 TIMEOUT 5s RECALL FROM EPISODIC ALL LIMIT 1")
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.pipeline_stages, Some(1));
    assert_eq!(result.count, 1);
}

#[test]
fn pipeline_fails_fast_on_stage_error() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    // 3 stages: RECALL (works), RECALL LIKE $missing (deterministic execution
    // error — the variable is unbound), RECALL (must not run — verifies
    // fail-fast). An unbound LIKE variable fails in the handler without any
    // bridge, so this is deterministic regardless of engram-mcp availability.
    // (As of Phase 2b, write stages like REFLECT are delegated rather than
    // rejected, so they are no longer a deterministic failure source.)
    let result = exec
        .query(
            "PIPELINE test TIMEOUT 5s RECALL FROM EPISODIC ALL LIMIT 1 | RECALL FROM SEMANTIC LIKE $missing | RECALL FROM SEMANTIC ALL LIMIT 1",
        )
        .unwrap();
    assert!(!result.success);
    assert!(result.error.is_some());
    let err = result.error.unwrap();
    assert!(
        err.contains("stage 2") || err.contains("missing") || err.contains("not bound"),
        "unexpected error: {}",
        err
    );
    // Verify fail-fast: stage 1 ran, stage 2 failed, stage 3 did NOT run
    assert_eq!(
        result.pipeline_stages,
        Some(1),
        "expected 1 stage completed before failure, got {:?}",
        result.pipeline_stages
    );
}

#[test]
fn pipeline_nested_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            "PIPELINE outer TIMEOUT 5s PIPELINE inner TIMEOUT 1s RECALL FROM EPISODIC ALL LIMIT 1",
        )
        .unwrap();
    // Whether the parser accepts or rejects nested pipelines depends on the grammar;
    // if it accepts them, our dispatcher should reject the inner pipeline.
    // If the parser rejects it as a syntax error, that's fine too — success must be false.
    assert!(!result.success, "nested pipelines should not succeed");
}
