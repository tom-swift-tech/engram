//! Top-level AQL executor — parses, dispatches, and returns results.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use rusqlite::Connection;
use serde_json::Value;

use crate::error::AqlResult;
use crate::exec_ctx::{BridgeHandle, ExecCtx};
use crate::result::QueryResult;
use crate::schema::verify_schema;
use crate::statements;
use crate::vector::cosine::register_vec_distance_cosine;

pub struct Executor {
    conn: Connection,
    /// Lazy bridge to `engram-mcp`. Resolved once from the environment and
    /// stored here so repeated `query_with_vars` calls reuse the warm child.
    bridge: BridgeHandle,
}

impl Executor {
    /// Build an Executor from an existing connection. Registers scalar
    /// functions and verifies schema.
    ///
    /// Registering `vec_distance_cosine` here (rather than only in `open`)
    /// ensures in-memory test connections built via `from_connection` also
    /// have the function available. Scalar function registration does not
    /// mutate the database — the Phase 1 `SQLITE_OPEN_READ_ONLY` discipline
    /// is preserved.
    pub fn from_connection(conn: Connection) -> AqlResult<Self> {
        register_vec_distance_cosine(&conn)?;
        verify_schema(&conn)?;
        // For in-memory / test connections there is no file path to give the
        // bridge — use a placeholder. The bridge is lazy and will only attempt
        // to spawn when embed_query is actually called.
        let bridge = BridgeHandle::new(
            crate::bridge::child::resolve_engram_mcp_cmd(None),
            Path::new(":memory:"),
        );
        Ok(Self { conn, bridge })
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
        register_vec_distance_cosine(&conn)?;
        verify_schema(&conn)?;
        let bridge = BridgeHandle::new(crate::bridge::child::resolve_engram_mcp_cmd(None), path);
        Ok(Self { conn, bridge })
    }

    /// Execute a single AQL query string with no variable bindings.
    ///
    /// Delegates to `query_with_vars` with an empty map — all existing callers
    /// (tests, subcommands, MCP handler) continue to work unchanged.
    pub fn query(&self, aql: &str) -> AqlResult<QueryResult> {
        self.query_with_vars(aql, BTreeMap::new())
    }

    /// Execute an AQL query with bound variables.
    ///
    /// Variables are referenced in AQL as `$name` (e.g. `RECALL … LIKE $q`).
    /// The map key is the name without the `$` sigil; the value may be:
    ///   - a JSON string — resolved to a query embedding via the bridge
    ///   - a JSON array of numbers — used directly as a pre-computed probe
    ///   - anything else — `InvalidQuery` at the handler
    pub fn query_with_vars(
        &self,
        aql: &str,
        vars: BTreeMap<String, Value>,
    ) -> AqlResult<QueryResult> {
        let start = Instant::now();

        let stmt = match aql_parser::parse(aql) {
            Ok(s) => s,
            Err(e) => {
                let mut result = QueryResult::error("Unknown", format!("parse error: {}", e));
                result.timing_ms = start.elapsed().as_millis() as u64;
                return Ok(result);
            }
        };

        let ctx = ExecCtx {
            conn: &self.conn,
            vars: &vars,
            bridge: &self.bridge,
        };

        // Route through the shared dispatcher
        let mut result = match statements::dispatch(&ctx, &stmt) {
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
