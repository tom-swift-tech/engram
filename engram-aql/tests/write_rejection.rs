//! Verify write statements are rejected with helpful errors in Phase 1.
//!
//! Phase 1 of engram-aql is read-only — all write operations (STORE, UPDATE,
//! FORGET, LINK, REFLECT) should be rejected at dispatch time with an error
//! that tells the agent to use the TypeScript MCP server instead. These tests
//! lock in that behavior so a future refactor can't silently lose a guard.

mod common;

use engram_aql::Executor;

#[test]
fn store_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"STORE INTO EPISODIC (event = "deploy", outcome = "success")"#)
        .unwrap();
    assert!(!result.success, "STORE should be rejected");
    assert_eq!(result.statement, "Store");
    let err = result.error.expect("error message");
    assert!(
        err.contains("STORE") && err.contains("engram_retain"),
        "error should mention STORE and engram_retain, got: {}",
        err
    );
}

#[test]
fn update_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    // UPDATE grammar: UPDATE INTO memory_type WHERE conditions (payload)
    let result = exec
        .query(
            r#"UPDATE INTO EPISODIC WHERE id = "e-001" (outcome = "rollback")"#,
        )
        .unwrap();
    assert!(!result.success, "UPDATE should be rejected");
    assert_eq!(result.statement, "Update");
    let err = result.error.expect("error message");
    assert!(
        err.contains("UPDATE") || err.contains("supersede"),
        "error should mention UPDATE or supersede, got: {}",
        err
    );
}

#[test]
fn forget_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"FORGET FROM EPISODIC WHERE id = "e-001""#)
        .unwrap();
    assert!(!result.success, "FORGET should be rejected");
    assert_eq!(result.statement, "Forget");
    let err = result.error.expect("error message");
    assert!(
        err.contains("FORGET") || err.contains("engram_forget"),
        "error should mention FORGET or engram_forget, got: {}",
        err
    );
}

#[test]
fn link_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    // LINK grammar: LINK FROM mem WHERE ... TO mem WHERE ... TYPE "name"
    let result = exec
        .query(
            r#"LINK FROM EPISODIC WHERE id = "e-001" TO SEMANTIC WHERE id = "s-001" TYPE "uses""#,
        )
        .unwrap();
    assert!(!result.success, "LINK should be rejected");
    assert_eq!(result.statement, "Link");
    let err = result.error.expect("error message");
    assert!(
        err.contains("LINK") || err.contains("Phase 2"),
        "error should mention LINK or Phase 2, got: {}",
        err
    );
}

#[test]
fn reflect_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"REFLECT FROM EPISODIC WHERE id = "e-001""#)
        .unwrap();
    assert!(!result.success, "REFLECT should be rejected");
    assert_eq!(result.statement, "Reflect");
    let err = result.error.expect("error message");
    assert!(
        err.contains("REFLECT") || err.contains("engram_reflect"),
        "error should mention REFLECT or engram_reflect, got: {}",
        err
    );
}
