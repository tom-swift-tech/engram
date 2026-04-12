//! MCP method handlers.

use serde_json::{json, Value};

use crate::executor::Executor;

pub fn handle_initialize(_params: &Value) -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "serverInfo": {
            "name": "engram-aql",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "tools": {}
        }
    })
}

pub fn handle_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "engram_aql",
                "description": "Execute an AQL (Agent Query Language) read query against this agent's memory. \
                    Supports: RECALL, SCAN, LOOKUP, LOAD, WITH LINKS, FOLLOW LINKS, AGGREGATE, ORDER BY, PIPELINE. \
                    Writes (STORE/UPDATE/FORGET/LINK/REFLECT) are not yet supported — use engram_retain via the TypeScript MCP server instead. \
                    Example: RECALL FROM EPISODIC ORDER BY created_at DESC LIMIT 5",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "AQL query string. Example: RECALL FROM EPISODIC ORDER BY created_at DESC LIMIT 5"
                        }
                    },
                    "required": ["query"]
                }
            }
        ]
    })
}

pub fn handle_tools_call(exec: &Executor, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing tool name".to_string())?;

    if name != "engram_aql" {
        return Err(format!("unknown tool: {}", name));
    }

    let query = params
        .get("arguments")
        .and_then(|a| a.get("query"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing query argument".to_string())?;

    let result = exec.query(query).map_err(|e| e.to_string())?;
    let result_json =
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?;

    Ok(json!({
        "content": [
            {
                "type": "text",
                "text": result_json
            }
        ],
        "isError": !result.success
    }))
}
