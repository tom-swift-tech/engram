//! Shared test helpers.

use rusqlite::Connection;

/// Build an in-memory database pre-loaded with the engram schema.
pub fn fresh_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    // The schema lives at ../../src/schema.sql relative to engram-aql/
    let schema = include_str!("../../../src/schema.sql");
    conn.execute_batch(schema).unwrap();
    conn
}

/// Load the deterministic test seed data into a fresh database.
pub fn seeded_db() -> Connection {
    let conn = fresh_db();
    let seed = include_str!("../fixtures/seed.sql");
    conn.execute_batch(seed).unwrap();
    conn
}
