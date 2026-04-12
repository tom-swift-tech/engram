//! Schema verification for `.engram` SQLite files.

use rusqlite::Connection;

use crate::error::{AqlResult, SchemaError};

/// Required tables for Phase 1 engram-aql operation.
const REQUIRED_TABLES: &[&str] = &[
    "chunks",
    "entities",
    "relations",
    "chunk_entities",
    "opinions",
    "observations",
    "working_memory",
    "tools",
    "bank_config",
];

/// Required columns on the `chunks` table. Catches old `.engram` files that
/// predate the AQL integration work.
const REQUIRED_CHUNK_COLUMNS: &[&str] = &[
    "id",
    "text",
    "memory_type",
    "trust_score",
    "is_active",
    "context",
    "source",
    "source_type",
    "created_at",
];

/// Verify the database has the schema shape engram-aql expects. Returns the
/// first missing table or column encountered, if any.
pub fn verify_schema(conn: &Connection) -> AqlResult<()> {
    for table in REQUIRED_TABLES {
        if !table_exists(conn, table)? {
            return Err(SchemaError::MissingTable((*table).into()).into());
        }
    }

    for column in REQUIRED_CHUNK_COLUMNS {
        if !column_exists(conn, "chunks", column)? {
            return Err(SchemaError::MissingColumn {
                table: "chunks".into(),
                column: (*column).into(),
            }
            .into());
        }
    }

    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> AqlResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> AqlResult<bool> {
    // Use SQLite's pragma table_info. The pragma_table_info function is only
    // available in newer SQLite builds (3.16+), so we fall back to a query
    // on the pragma table.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();
    Ok(names.iter().any(|n| n == column))
}
