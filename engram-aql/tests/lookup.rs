//! LOOKUP integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn lookup_by_id() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"LOOKUP FROM EPISODIC KEY id = "e-001""#)
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 1);
}

#[test]
fn lookup_nonexistent_returns_empty() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"LOOKUP FROM EPISODIC KEY id = "nonexistent""#)
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 0);
}
