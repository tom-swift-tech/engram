//! JSON-RPC stdio client — mirrors the framing used by `mcp/mod.rs`.
//!
//! Protocol: line-delimited JSON (`\n` framing, flush after each write).
//! Single-threaded and sequential: one outstanding request at a time, which
//! matches the `engram-mcp` server model.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

use crate::error::{AqlError, AqlResult};
use crate::mcp::protocol::{ClientRequest, ClientResponse};

pub struct JsonRpcClient {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// Tracks whether the child EOF'd. After a failed call the caller can
    /// decide to respawn; the client itself does not respawn.
    pub eof: bool,
}

impl JsonRpcClient {
    pub fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            eof: false,
        }
    }

    /// Monotonically incrementing request id; call before building the request.
    pub fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Send a JSON-RPC request and return the `result` value on success,
    /// or an `AqlError` if the response carries an `error` field or if I/O
    /// fails.
    pub async fn call(&mut self, method: &str, params: Value) -> AqlResult<Value> {
        let id = self.next_id();
        let req = ClientRequest::new(id, method, params);
        self.call_raw(req).await
    }

    /// Send a pre-built request and return the result value.
    ///
    /// Exposed to `child.rs` so the `initialize` call can reuse `next_id`.
    pub async fn call_raw(&mut self, req: ClientRequest) -> AqlResult<Value> {
        let json = serde_json::to_string(&req)?;
        self.stdin.write_all(json.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;

        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).await?;
        if n == 0 {
            self.eof = true;
            return Err(AqlError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "engram-mcp child closed stdout unexpectedly (EOF). \
                 The process may have crashed — check stderr for details.",
            )));
        }

        let resp: ClientResponse = serde_json::from_str(line.trim())?;

        if let Some(err) = resp.error {
            return Err(AqlError::InvalidQuery(format!(
                "engram-mcp error {}: {}",
                err.code, err.message
            )));
        }

        resp.result.ok_or_else(|| {
            AqlError::InvalidQuery(
                "engram-mcp returned a response with neither result nor error".to_string(),
            )
        })
    }

    /// Send a JSON-RPC notification (no `id`, no response expected).
    pub async fn notify(&mut self, method: &str, params: Value) -> AqlResult<()> {
        // Notifications have no `id` field — use a plain inline struct.
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        let json = serde_json::to_string(&msg)?;
        self.stdin.write_all(json.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }
}
