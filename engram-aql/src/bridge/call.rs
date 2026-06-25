//! Generic MCP `tools/call` over the bridge.
//!
//! Used for both query embedding (`engram_embed`) and write delegation
//! (`engram_retain`/`_supersede`/`_forget`/`_reflect`). `engram-mcp` wraps a
//! tool handler's return as
//! `{ "content": [{ "type": "text", "text": "<json-or-message>" }], "isError"?: bool }`.

use serde_json::{json, Value};

use crate::error::{AqlError, AqlResult};

use super::client::JsonRpcClient;

/// Call an MCP tool on the `engram-mcp` child and return its result payload.
///
/// On `isError`, returns `InvalidQuery` carrying the tool's message. Otherwise
/// returns the parsed inner JSON when `content[0].text` is JSON, else the raw
/// text as a `Value::String`.
pub fn call_tool(client: &mut JsonRpcClient, name: &str, arguments: Value) -> AqlResult<Value> {
    let result = client.call(
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    )?;
    interpret_tool_result(&result, name)
}

/// Interpret a raw `tools/call` result value into either the tool's payload or
/// an error. Factored out (no client) so it is unit-testable.
pub(crate) fn interpret_tool_result(result: &Value, name: &str) -> AqlResult<Value> {
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let text = tool_content_text(result, name)?;

    if is_error {
        return Err(AqlError::InvalidQuery(format!("{name} failed: {text}")));
    }

    // Most engram tools JSON-encode their return; some may emit a plain string.
    Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
}

/// Extract `content[0].text` from a `tools/call` result.
fn tool_content_text(result: &Value, name: &str) -> AqlResult<String> {
    result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            AqlError::InvalidQuery(format!(
                "{name} response missing content[0].text; got: {result}"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interprets_json_payload() {
        let result = json!({
            "content": [{ "type": "text", "text": "{\"chunkId\":\"c-1\",\"deduped\":false}" }]
        });
        let v = interpret_tool_result(&result, "engram_retain").unwrap();
        assert_eq!(v["chunkId"], "c-1");
        assert_eq!(v["deduped"], false);
    }

    #[test]
    fn interprets_plain_string_payload() {
        let result = json!({ "content": [{ "type": "text", "text": "ok" }] });
        let v = interpret_tool_result(&result, "engram_reflect").unwrap();
        assert_eq!(v, Value::String("ok".to_string()));
    }

    #[test]
    fn is_error_surfaces_message() {
        let result = json!({
            "content": [{ "type": "text", "text": "chunk not found" }],
            "isError": true
        });
        let err = interpret_tool_result(&result, "engram_forget").unwrap_err();
        assert!(format!("{err}").contains("chunk not found"));
        assert!(format!("{err}").contains("engram_forget"));
    }

    #[test]
    fn missing_content_errors() {
        let result = json!({ "other": "field" });
        assert!(interpret_tool_result(&result, "engram_retain").is_err());
    }
}
