//! MCP JSON-RPC message types.
//!
//! Minimal subset needed for the initialize / tools/list / tools/call
//! method trio. Notifications (requests without an `id`) are handled by
//! parsing into `JsonRpcRequest` and ignoring the response path.
//!
//! The server-side types (`JsonRpcRequest` / `JsonRpcResponse`) handle
//! inbound deserialization + outbound serialization for the AQL MCP server.
//! The client-side type (`ClientRequest`) handles outbound serialization for
//! the bridge — a separate type so the server's `Deserialize`-only constraint
//! on `JsonRpcRequest` remains unchanged.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)]
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Client-side types (bridge sends requests, receives responses)
// ---------------------------------------------------------------------------

/// Outbound JSON-RPC request sent by the bridge to the `engram-mcp` child.
///
/// Separate from `JsonRpcRequest` (which is server-inbound, `Deserialize`-only)
/// so neither type's derive constraints change.
#[derive(Debug, Serialize)]
pub struct ClientRequest {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: String,
    pub params: Value,
}

impl ClientRequest {
    pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            method: method.into(),
            params,
        }
    }
}

/// Inbound JSON-RPC response received by the bridge from the `engram-mcp` child.
#[derive(Debug, Deserialize)]
pub struct ClientResponse {
    #[allow(dead_code)]
    pub jsonrpc: String,
    pub id: Value,
    pub result: Option<Value>,
    pub error: Option<ClientResponseError>,
}

#[derive(Debug, Deserialize)]
pub struct ClientResponseError {
    pub code: i32,
    pub message: String,
}

// ---------------------------------------------------------------------------

impl JsonRpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
            }),
        }
    }
}
