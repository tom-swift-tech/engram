//! Embed helper — calls `engram_embed` over the JSON-RPC bridge and parses
//! the `content[0].text` JSON that `engram-mcp`'s `tools/call` wraps the
//! handler return in.

use serde_json::{json, Value};

use crate::error::{AqlError, AqlResult};

use super::client::JsonRpcClient;

/// Call `engram_embed` on the `engram-mcp` child and return the embedding as
/// a `Vec<f32>`.
///
/// The MCP `tools/call` response shape from the TS handler is:
/// ```json
/// {
///   "content": [{ "type": "text", "text": "{\"embedding\":[...],\"dimensions\":768}" }]
/// }
/// ```
/// We unwrap the `content[0].text` inner JSON to reach `embedding`.
pub async fn embed_query(client: &mut JsonRpcClient, text: &str) -> AqlResult<Vec<f32>> {
    let params = json!({
        "name": "engram_embed",
        "arguments": {
            "text": text,
            "mode": "query"
        }
    });

    let result = client.call("tools/call", params).await?;

    parse_embed_result(&result)
}

/// Parse the `tools/call` response value into a `Vec<f32>`.
fn parse_embed_result(result: &Value) -> AqlResult<Vec<f32>> {
    // result.content[0].text is a JSON string containing { embedding, dimensions }.
    let text = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| {
            AqlError::InvalidQuery(format!(
                "engram_embed response missing content[0].text; got: {}",
                result
            ))
        })?;

    let inner: Value = serde_json::from_str(text).map_err(|e| {
        AqlError::InvalidQuery(format!(
            "engram_embed content[0].text is not valid JSON: {e}; raw: {text}"
        ))
    })?;

    let embedding = inner
        .get("embedding")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            AqlError::InvalidQuery(format!(
                "engram_embed JSON missing 'embedding' array; got: {inner}"
            ))
        })?;

    embedding
        .iter()
        .map(|v| {
            v.as_f64().map(|f| f as f32).ok_or_else(|| {
                AqlError::InvalidQuery(format!("non-numeric value in embedding array: {v}"))
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_embed_result_ok() {
        let embedding: Vec<f64> = (0..768).map(|i| i as f64 * 0.001).collect();
        let result = json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string(&json!({
                    "embedding": embedding,
                    "dimensions": 768
                })).unwrap()
            }]
        });
        let vec = parse_embed_result(&result).unwrap();
        assert_eq!(vec.len(), 768);
        assert!((vec[1] - 0.001_f32).abs() < 1e-5);
    }

    #[test]
    fn parse_embed_result_missing_content() {
        let result = json!({ "other": "field" });
        assert!(parse_embed_result(&result).is_err());
    }

    #[test]
    fn parse_embed_result_invalid_inner_json() {
        let result = json!({
            "content": [{ "type": "text", "text": "not-json" }]
        });
        assert!(parse_embed_result(&result).is_err());
    }
}
