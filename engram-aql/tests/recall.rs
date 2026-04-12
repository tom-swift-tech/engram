//! RECALL statement integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn recall_all_semantic() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("RECALL FROM SEMANTIC ALL").unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.statement, "Recall");
    assert!(result.count >= 3);
}

#[test]
fn recall_episodic_with_context_filter() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC WHERE context = \"ops\"")
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    // e-001, e-002, e-004 are ops
    assert_eq!(result.count, 3);
}

#[test]
fn recall_with_json_field_filter() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"RECALL FROM EPISODIC WHERE outcome = "success""#)
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    // e-001, e-003, e-004 are success
    assert_eq!(result.count, 3);
}

#[test]
fn recall_with_compound_where() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"RECALL FROM EPISODIC WHERE context = "ops" AND outcome = "success""#)
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    // e-001 and e-004 are ops+success
    assert_eq!(result.count, 2);
}

#[test]
fn recall_with_gt_comparison() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC WHERE trust_score > 0.75")
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    // e-001 (0.9), e-003 (0.8), e-004 (0.85)
    assert_eq!(result.count, 3);
}

#[test]
fn recall_with_limit() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("RECALL FROM EPISODIC ALL LIMIT 2").unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 2);
}

#[test]
fn recall_with_order_by_desc() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC ALL ORDER BY trust_score DESC LIMIT 1")
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 1);
    let trust = result.data[0]
        .get("trust_score")
        .and_then(|v| v.as_f64())
        .unwrap();
    assert!((trust - 0.9).abs() < 0.001);
}

#[test]
fn recall_with_return_fields_filters_columns() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query("RECALL FROM EPISODIC ALL LIMIT 1 RETURN id, trust_score")
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    let row = &result.data[0];
    assert!(row.get("id").is_some());
    assert!(row.get("trust_score").is_some());
    assert!(row.get("text").is_none()); // filtered out
}

#[test]
fn recall_invalid_query_returns_error_result() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("NOT A VALID QUERY").unwrap();
    assert!(!result.success);
    assert!(result.error.is_some());
}
