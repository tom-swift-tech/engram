//! `engram-mcp` JSON-RPC stdio bridge.
//!
//! Lazily spawns an `engram-mcp` (TypeScript) child process and exposes a
//! thin `embed_query` helper over it. The bridge is single-threaded and
//! sequential — one outstanding request at a time, which matches the server
//! model in `mcp/mod.rs`.
//!
//! Discovery order for the `engram-mcp` binary:
//!   1. Explicit command passed at construction (plumbed from `--engram-mcp-cmd`).
//!   2. `ENGRAM_MCP_CMD` environment variable (may include args, e.g.
//!      `node /abs/path/to/dist/mcp-server.js`).
//!   3. `engram-mcp` on PATH.

pub mod child;
pub mod client;
pub mod embed;

use std::path::Path;

use crate::error::AqlResult;
use child::ChildProcess;
use client::JsonRpcClient;

/// A ready bridge owning a live `engram-mcp` child + JSON-RPC client.
pub struct Bridge {
    client: JsonRpcClient,
    // Keep the child alive for the lifetime of the bridge. Dropping it sends
    // SIGKILL (on Unix) or TerminateProcess (on Windows).
    _child: ChildProcess,
}

impl Bridge {
    /// Spawn an `engram-mcp` child for `db_path` and perform the MCP
    /// `initialize` handshake. Returns a ready bridge.
    ///
    /// `cmd` is the resolved command (program + args without the db path).
    /// The db path is appended as the final argument before spawn.
    pub async fn new(cmd: Vec<String>, db_path: &Path) -> AqlResult<Self> {
        let (child, client) = child::spawn(cmd, db_path).await?;
        Ok(Self {
            client,
            _child: child,
        })
    }

    /// Embed `text` in query mode by calling `engram_embed` on the child.
    pub async fn embed_query(&mut self, text: &str) -> AqlResult<Vec<f32>> {
        embed::embed_query(&mut self.client, text).await
    }
}
