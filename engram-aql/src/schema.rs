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
    // Double-quote the identifier so callers with less-trusted table names
    // can't inject PRAGMA arguments. Escape any embedded double quotes.
    let quoted = format!("\"{}\"", table.replace('"', "\"\""));
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quoted))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;

    // Propagate row errors rather than silently dropping them — a row error
    // here would indicate a real SQLite problem that we want surfaced.
    let mut names = Vec::new();
    for row in rows {
        names.push(row?);
    }
    Ok(names.iter().any(|n| n == column))
}
