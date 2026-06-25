//! Write-statement guards that do NOT require a bridge.
//!
//! As of Phase 2b, STORE/UPDATE/FORGET/REFLECT are delegated to the TS retain
//! pipeline (see `tests/write_delegate.rs` for the gated round-trips). What this
//! suite locks in are the deterministic guards that fire *before* any bridge
//! call: LINK is still rejected, and writes validate their target/payload up
//! front so a misuse fails cleanly without spawning engram-mcp.

mod common;

use engram_aql::Executor;

#[test]
fn link_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(
            r#"LINK FROM EPISODIC WHERE id = "e-001" TO SEMANTIC WHERE id = "s-001" TYPE "uses""#,
        )
        .unwrap();
    assert!(!result.success, "LINK should be rejected");
    assert_eq!(result.statement, "Link");
    let err = result.error.expect("error message");
    assert!(
        err.contains("LINK") || err.contains("relation"),
        "error should explain LINK is unsupported, got: {err}"
    );
}

#[test]
fn store_into_non_chunk_type_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    // PROCEDURAL maps to the observations table, not chunks — not writable here.
    let result = exec
        .query(r#"STORE INTO PROCEDURAL (text = "a pattern")"#)
        .unwrap();
    assert!(!result.success, "STORE INTO PROCEDURAL should be rejected");
    let err = result.error.expect("error message");
    assert!(
        err.contains("SEMANTIC") || err.contains("EPISODIC"),
        "error should name the writable memory types, got: {err}"
    );
}

#[test]
fn store_without_text_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    // No `text` field — fails validation before any bridge call.
    let result = exec
        .query(r#"STORE INTO SEMANTIC (source = "manual")"#)
        .unwrap();
    assert!(!result.success, "STORE without text should be rejected");
    let err = result.error.expect("error message");
    assert!(
        err.contains("text"),
        "error should mention the required text field, got: {err}"
    );
}

#[test]
fn update_without_text_is_rejected() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"UPDATE INTO EPISODIC WHERE id = "e-001" (outcome = "rollback")"#)
        .unwrap();
    assert!(!result.success, "UPDATE without text should be rejected");
    let err = result.error.expect("error message");
    assert!(
        err.contains("text"),
        "error should mention the required text field, got: {err}"
    );
}
