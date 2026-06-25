//! `engram-mcp` child process lifecycle — discovery, spawn, and MCP initialize.

use std::io::BufReader;
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::json;

use crate::error::{AqlError, AqlResult};
use crate::mcp::protocol::ClientRequest;

use super::client::JsonRpcClient;

/// Opaque handle keeping the child process alive.
///
/// When this value drops, `kill()` is attempted so the `engram-mcp` Node
/// process does not outlive the bridge. Best-effort — callers that want a
/// clean shutdown should drop the bridge explicitly.
pub struct ChildProcess {
    inner: Child,
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        // Best-effort: ignore error (process may have already exited).
        let _ = self.inner.kill();
    }
}

/// Resolve the `engram-mcp` command (program + leading args, without the db
/// path). Discovery order:
///   1. `explicit` — passed from a `--engram-mcp-cmd` flag.
///   2. `ENGRAM_MCP_CMD` env var — may contain a command with args
///      (e.g. `node /abs/path/to/dist/mcp-server.js`); split on whitespace.
///   3. `engram-mcp` on PATH — checked via `which`-style PATH walk.
///
/// Returns `None` when none of the three sources resolves; the test gate
/// checks this before spawning.
pub fn resolve_engram_mcp_cmd(explicit: Option<String>) -> Option<Vec<String>> {
    // (1) explicit override
    if let Some(cmd) = explicit {
        if !cmd.is_empty() {
            return Some(split_cmd(&cmd));
        }
    }

    // (2) ENGRAM_MCP_CMD env
    if let Ok(env_cmd) = std::env::var("ENGRAM_MCP_CMD") {
        if !env_cmd.is_empty() {
            return Some(split_cmd(&env_cmd));
        }
    }

    // (3) engram-mcp on PATH
    if which_on_path("engram-mcp") {
        return Some(vec!["engram-mcp".to_string()]);
    }

    None
}

/// Split a command string into program + args on whitespace. Handles the
/// common `ENGRAM_MCP_CMD="node /path/to/dist/mcp-server.js"` pattern.
fn split_cmd(cmd: &str) -> Vec<String> {
    cmd.split_whitespace().map(str::to_string).collect()
}

/// Returns true if `name` resolves to an executable on the system PATH.
fn which_on_path(name: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(sep) {
            let mut candidate = std::path::PathBuf::from(dir);
            candidate.push(name);
            // On Windows, also check with .cmd / .exe suffixes.
            if candidate.exists() {
                return true;
            }
            if cfg!(windows) {
                for ext in &[".cmd", ".exe", ".bat"] {
                    let mut c = candidate.clone();
                    c.set_extension(ext.trim_start_matches('.'));
                    if c.exists() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Spawn the `engram-mcp` child process and perform the MCP `initialize`
/// handshake. Returns the child handle and a ready JSON-RPC client.
///
/// `cmd` is `[program, ...leading_args]` without the db path. The db path is
/// appended as the final argument before spawn.
///
/// On broken pipe / EOF during `initialize`, returns an actionable error.
pub fn spawn(cmd: Vec<String>, db_path: &Path) -> AqlResult<(ChildProcess, JsonRpcClient)> {
    if cmd.is_empty() {
        return Err(AqlError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "empty engram-mcp command — provide via (1) --engram-mcp-cmd, \
             (2) ENGRAM_MCP_CMD env var, or (3) 'engram-mcp' on PATH",
        )));
    }

    let program = &cmd[0];
    let leading_args = &cmd[1..];
    let db_str = db_path.to_string_lossy();

    let mut child = Command::new(program)
        .args(leading_args)
        .arg(db_str.as_ref())
        // Pipe stdin/stdout for JSON-RPC; inherit stderr so TS diagnostics
        // (e.g. "[engram-mcp] Serving ...") flow to the user's terminal.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| {
            AqlError::Io(std::io::Error::new(
                e.kind(),
                format!(
                    "failed to spawn engram-mcp '{}': {}. \
                     Provide the binary via (1) --engram-mcp-cmd <cmd>, \
                     (2) ENGRAM_MCP_CMD env var (e.g. \"node /abs/path/dist/mcp-server.js\"), \
                     or (3) ensure 'engram-mcp' is on PATH.",
                    program, e
                ),
            ))
        })?;

    let stdin: ChildStdin = child.stdin.take().ok_or_else(|| {
        AqlError::Io(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "child stdin unavailable",
        ))
    })?;
    let stdout: ChildStdout = child.stdout.take().ok_or_else(|| {
        AqlError::Io(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "child stdout unavailable",
        ))
    })?;

    let mut client = JsonRpcClient::new(stdin, BufReader::new(stdout));

    // MCP initialize handshake — must complete before the bridge is usable.
    let init_params = json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {
            "name": "engram-aql-bridge",
            "version": env!("CARGO_PKG_VERSION")
        }
    });
    let init_req = ClientRequest::new(client.next_id(), "initialize", init_params);
    client.call_raw(init_req).map_err(|e| {
        AqlError::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            format!("engram-mcp initialize failed: {}", e),
        ))
    })?;

    // Send `notifications/initialized` (no response expected).
    let notif = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let notif_json = serde_json::to_string(&notif)?;
    client.write_line(&notif_json).map_err(AqlError::Io)?;

    Ok((ChildProcess { inner: child }, client))
}
