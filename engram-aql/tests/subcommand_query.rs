//! CLI query subcommand integration test.
//! Creates a temp .engram file, runs `engram-aql query`, asserts on stdout.

mod common;

use std::process::Command;

use tempfile::NamedTempFile;

fn build_test_db() -> NamedTempFile {
    let file = NamedTempFile::new().unwrap();
    let path = file.path();
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(common::SCHEMA_SQL).unwrap();
    conn.execute_batch(include_str!("fixtures/seed.sql")).unwrap();
    drop(conn);
    file
}

#[test]
fn query_subcommand_returns_json() {
    let file = build_test_db();

    let output = Command::new(env!("CARGO_BIN_EXE_engram-aql"))
        .arg("query")
        .arg(file.path())
        .arg("RECALL FROM EPISODIC ALL LIMIT 2")
        .output()
        .expect("failed to run engram-aql");

    assert!(
        output.status.success(),
        "engram-aql exited non-zero\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout should be valid JSON");
    assert_eq!(json["success"], true);
    assert_eq!(json["statement"], "Recall");
    assert!(json["count"].as_u64().unwrap() >= 1);
}

#[test]
fn query_subcommand_nonzero_exit_on_parse_error() {
    let file = build_test_db();

    let output = Command::new(env!("CARGO_BIN_EXE_engram-aql"))
        .arg("query")
        .arg(file.path())
        .arg("NOT A VALID QUERY")
        .output()
        .expect("failed to run engram-aql");

    // Parse errors produce a JSON error result AND a non-zero exit code
    assert!(!output.status.success(), "parse error should exit non-zero");

    let stdout = String::from_utf8(output.stdout).unwrap();
    let json: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout should still be valid JSON");
    assert_eq!(json["success"], false);
    assert!(json["error"].is_string());
}
