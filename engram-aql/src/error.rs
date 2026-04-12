//! Error types for engram-aql

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AqlError {
    #[error("parse error: {0}")]
    Parse(#[from] aql_parser::error::ParseError),

    #[error("schema error: {0}")]
    Schema(#[from] SchemaError),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("unsupported statement: {0}")]
    Unsupported(String),

    #[error("invalid query: {0}")]
    InvalidQuery(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Error)]
pub enum SchemaError {
    #[error(
        "database is missing required table '{0}'. \
         This may be an older .engram file — open it once with TypeScript \
         Engram (e.g., `npx engram-mcp <path>`) to upgrade the schema."
    )]
    MissingTable(String),

    #[error("table {table} is missing required column: {column}")]
    MissingColumn { table: String, column: String },
}

pub type AqlResult<T> = Result<T, AqlError>;
