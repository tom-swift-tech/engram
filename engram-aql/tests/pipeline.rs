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
fn pipeline_fails_fast_on_write_stage() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            r#"PIPELINE test TIMEOUT 5s RECALL FROM EPISODIC ALL LIMIT 1 | STORE INTO EPISODIC (foo = "bar")"#,
        )
        .unwrap();
    // STORE is rejected in Phase 1, so stage 2 fails, the pipeline should fail fast
    assert!(!result.success);
    assert!(result.error.is_some());
    let err = result.error.unwrap();
    assert!(
        err.contains("stage") || err.contains("STORE") || err.contains("Store"),
        "unexpected error: {}",
        err
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
