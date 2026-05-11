//! Top-level AQL executor — parses, dispatches, and returns results.

use std::path::Path;
use std::time::Instant;

use rusqlite::Connection;

use crate::error::AqlResult;
use crate::result::QueryResult;
use crate::schema::verify_schema;
use crate::statements;

pub struct Executor {
    conn: Connection,
}

impl Executor {
    /// Build an Executor from an existing connection. Verifies schema.
    pub fn from_connection(conn: Connection) -> AqlResult<Self> {
        verify_schema(&conn)?;
        Ok(Self { conn })
    }

    /// Open a `.engram` SQLite file and build an Executor.
    pub fn open(path: &Path) -> AqlResult<Self> {
        use rusqlite::OpenFlags;
        // Phase 1 is read-only. Opening with SQLITE_OPEN_READ_ONLY enforces this
        // at the SQLite layer — even a bug that routes a write statement through
        // `dispatch` will fail at the SQLite call rather than silently modifying
        // the shared `.engram` file. NO_MUTEX is safe because the MCP stdio loop
        // is single-threaded and uses the connection sequentially.
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // 5-second busy timeout matches the TypeScript side. If TS Engram is
        // holding a write transaction, this gives it time to commit before we
        // surface a SQLITE_BUSY error.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Self::from_connection(conn)
    }

    /// Execute a single AQL query string.
    pub fn query(&self, aql: &str) -> AqlResult<QueryResult> {
        let start = Instant::now();

        let stmt = match aql_parser::parse(aql) {
            Ok(s) => s,
            Err(e) => {
                let mut result = QueryResult::error("Unknown", format!("parse error: {}", e));
                result.timing_ms = start.elapsed().as_millis() as u64;
                return Ok(result);
            }
        };

        // Route through the shared dispatcher
        let mut result = match statements::dispatch(&self.conn, &stmt) {
            Ok(r) => r,
            Err(crate::error::AqlError::InvalidQuery(msg)) => {
                // InvalidQuery errors are user-facing validation failures (e.g. injection
                // guards, unsupported operators). Surface them as a result rather than
                // propagating as a hard Err so callers can inspect result.error.
                QueryResult::error("Unknown", msg)
            }
            Err(e) => return Err(e),
        };
        result.timing_ms = start.elapsed().as_millis() as u64;
        Ok(result)
    }
}
