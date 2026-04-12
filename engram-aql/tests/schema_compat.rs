//! Schema verification integration tests.

mod common;

use engram_aql::{verify_schema, AqlError, SchemaError};
use rusqlite::Connection;

#[test]
fn fresh_engram_schema_passes_verification() {
    let conn = common::fresh_db();
    verify_schema(&conn).expect("fresh schema must pass verification");
}

#[test]
fn seeded_db_also_passes_verification() {
    let conn = common::seeded_db();
    verify_schema(&conn).expect("seeded schema must pass verification");
}

#[test]
fn missing_chunks_table_errors() {
    let conn = Connection::open_in_memory().unwrap();
    // Build a database with everything EXCEPT chunks
    conn.execute_batch(
        r#"
        CREATE TABLE entities (id TEXT PRIMARY KEY);
        CREATE TABLE relations (id TEXT PRIMARY KEY);
        CREATE TABLE chunk_entities (chunk_id TEXT, entity_id TEXT);
        CREATE TABLE opinions (id TEXT PRIMARY KEY);
        CREATE TABLE observations (id TEXT PRIMARY KEY);
        CREATE TABLE working_memory (id TEXT PRIMARY KEY);
        CREATE TABLE tools (id TEXT PRIMARY KEY);
        CREATE TABLE bank_config (key TEXT PRIMARY KEY, value TEXT);
        "#,
    )
    .unwrap();

    match verify_schema(&conn) {
        Err(AqlError::Schema(SchemaError::MissingTable(t))) => {
            assert_eq!(t, "chunks");
        }
        other => panic!("expected MissingTable('chunks'), got: {:?}", other),
    }
}

#[test]
fn missing_tools_table_errors_with_hint() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(include_str!("../../src/schema.sql")).unwrap();
    conn.execute_batch("DROP TABLE tools").unwrap();

    match verify_schema(&conn) {
        Err(AqlError::Schema(SchemaError::MissingTable(t))) => {
            assert_eq!(t, "tools");
        }
        other => panic!("expected MissingTable('tools'), got: {:?}", other),
    }
}
