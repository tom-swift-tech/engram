//! SCAN integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn scan_working_memory_returns_active_sessions() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("SCAN FROM WORKING WINDOW LAST 10").unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.statement, "Scan");
    assert!(result.count >= 2); // seed has 2 working sessions
}

#[test]
fn scan_window_last_n_limits_results() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("SCAN FROM WORKING WINDOW LAST 1").unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 1);
}
