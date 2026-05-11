//! LOAD integration tests.

mod common;

use engram_aql::Executor;

#[test]
fn load_tools_ordered_by_ranking() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("LOAD FROM TOOLS ALL").unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.statement, "Load");
    assert_eq!(result.count, 3);
    // Highest ranking first
    let first_name = result.data[0].get("name").and_then(|v| v.as_str()).unwrap();
    assert_eq!(first_name, "resize");
}

#[test]
fn load_with_name_filter() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec
        .query(r#"LOAD FROM TOOLS WHERE name = "compress""#)
        .unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 1);
}

#[test]
fn load_with_limit() {
    let conn = common::seeded_db();
    let exec = Executor::from_connection(conn).unwrap();
    let result = exec.query("LOAD FROM TOOLS ALL LIMIT 2").unwrap();
    assert!(result.success, "error: {:?}", result.error);
    assert_eq!(result.count, 2);
}
