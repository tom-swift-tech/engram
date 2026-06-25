//! Execution context threaded through the AQL dispatcher and handlers.
//!
//! `ExecCtx` bundles the three resources that handlers may need:
//!   - `conn`   — the read-only SQLite connection (always present)
//!   - `vars`   — bound query variables (`LIKE $q`, `PATTERN $q`)
//!   - `bridge` — lazy `engram-mcp` child for embedding (spawned on first use)
//!
//! Handlers that don't need vars or the bridge simply ignore those fields.
//! The `BridgeHandle` uses `RefCell` so `embed_query` can be called through a
//! shared `&ExecCtx` without requiring `&mut`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;

use crate::bridge::Bridge;
use crate::error::{AqlError, AqlResult};

// ---------------------------------------------------------------------------
// BridgeHandle — lazy spawn behind interior mutability
// ---------------------------------------------------------------------------

/// Lazy `engram-mcp` bridge. Spawned on the first call to `embed_query`;
/// subsequent calls reuse the warm child. `RefCell` makes this usable from
/// `&ExecCtx` (no `&mut` needed at the call site).
pub struct BridgeHandle {
    /// Resolved command (program + leading args). `None` when the binary is
    /// not discoverable — `embed_query` returns an `InvalidQuery` error in
    /// that case with an actionable message.
    cmd: Option<Vec<String>>,
    db_path: std::path::PathBuf,
    inner: RefCell<Option<Bridge>>,
}

impl BridgeHandle {
    pub fn new(cmd: Option<Vec<String>>, db_path: &Path) -> Self {
        Self {
            cmd,
            db_path: db_path.to_path_buf(),
            inner: RefCell::new(None),
        }
    }

    /// Embed `text` in query mode. Spawns the `engram-mcp` child on first
    /// call; subsequent calls reuse the warm process.
    ///
    /// Returns `InvalidQuery` (not `Io`) when `engram-mcp` is not discoverable
    /// so the error surfaces cleanly in `QueryResult.error` rather than
    /// propagating as a hard Err.
    pub fn embed_query(&self, text: &str) -> AqlResult<Vec<f32>> {
        let cmd = self.cmd.as_ref().ok_or_else(|| {
            AqlError::InvalidQuery(
                "vector search requires engram-mcp to be discoverable. \
                 Provide it via (1) --engram-mcp-cmd <cmd>, \
                 (2) ENGRAM_MCP_CMD env var (e.g. \"node /abs/path/dist/mcp-server.js\"), \
                 or (3) ensure 'engram-mcp' is on PATH."
                    .to_string(),
            )
        })?;

        let mut guard = self.inner.borrow_mut();
        if guard.is_none() {
            *guard = Some(Bridge::new(cmd.clone(), &self.db_path)?);
        }
        guard.as_mut().unwrap().embed_query(text)
    }
}

// ---------------------------------------------------------------------------
// ExecCtx
// ---------------------------------------------------------------------------

/// Execution context passed to `statements::dispatch` and available to all
/// handlers. Handlers that don't need `vars` or `bridge` simply ignore them.
pub struct ExecCtx<'a> {
    pub conn: &'a Connection,
    /// Bound query variables keyed by name (without the `$` sigil).
    /// `BTreeMap` for determinism — order is stable across calls.
    pub vars: &'a BTreeMap<String, Value>,
    pub bridge: &'a BridgeHandle,
}
