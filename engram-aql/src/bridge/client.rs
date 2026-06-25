//! JSON-RPC stdio client — mirrors the framing used by `mcp/mod.rs`.
//!
//! Protocol: line-delimited JSON (`\n` framing, flush after each write).
//! Single-threaded and sequential: one outstanding request at a time, which
//! matches the `engram-mcp` server model. All I/O is synchronous so the
//! client can be called from sync contexts (e.g. `Executor::query`).

use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};

use serde_json::Value;

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
    pub fn new(stdin: ChildStdin, stdout: BufReader<ChildStdout>) -> Self {
        Self {
            stdin,
            stdout,
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

    /// Write a line to the child's stdin. Used by `child.rs` for notifications
    /// (which have no response) and internally for request framing.
    pub fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()
    }

    /// Send a JSON-RPC request and return the `result` value on success,
    /// or an `AqlError` if the response carries an `error` field or if I/O
    /// fails.
    pub fn call(&mut self, method: &str, params: Value) -> AqlResult<Value> {
        let id = self.next_id();
        let req = ClientRequest::new(id, method, params);
        self.call_raw(req)
    }

    /// Send a pre-built request and return the result value.
    ///
    /// Exposed to `child.rs` so the `initialize` call can reuse `next_id`.
    pub fn call_raw(&mut self, req: ClientRequest) -> AqlResult<Value> {
        let json = serde_json::to_string(&req)?;
        self.write_line(&json).map_err(AqlError::Io)?;

        let mut line = String::new();
        let n = self.stdout.read_line(&mut line)?;
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
}
