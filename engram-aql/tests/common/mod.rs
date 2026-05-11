//! Shared test helpers.

use rusqlite::Connection;

/// The Engram schema SQL, loaded at compile time from the shared `src/schema.sql`.
/// Both TypeScript Engram and the Rust engram-aql binary use this exact schema.
///
/// The path is relative to this source file: `tests/common/mod.rs` is three
/// directories down from the repo root (engram-aql/tests/common/).
pub const SCHEMA_SQL: &str = include_str!("../../../src/schema.sql");

/// Build an in-memory database pre-loaded with the engram schema.
#[allow(dead_code)]
pub fn fresh_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA_SQL).unwrap();
    conn
}

/// Load the deterministic test seed data into a fresh database.
#[allow(dead_code)]
pub fn seeded_db() -> Connection {
    let conn = fresh_db();
    let seed = include_str!("../fixtures/seed.sql");
    conn.execute_batch(seed).unwrap();
    conn
}
