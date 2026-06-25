//! Embed helper — calls `engram_embed` over the bridge (via the generic
//! `call_tool`) and extracts the `embedding` array from the returned payload.

use serde_json::{json, Value};

use crate::error::{AqlError, AqlResult};

use super::client::JsonRpcClient;

/// Call `engram_embed` on the `engram-mcp` child and return the embedding as
/// a `Vec<f32>`. `call_tool` handles the `content[0].text` unwrapping; here we
/// pull the `embedding` array out of the resulting `{ embedding, dimensions }`.
pub fn embed_query(client: &mut JsonRpcClient, text: &str) -> AqlResult<Vec<f32>> {
    let payload = super::call::call_tool(
        client,
        "engram_embed",
        json!({ "text": text, "mode": "query" }),
    )?;
    parse_embedding(&payload)
}

/// Extract the `embedding` array from the `engram_embed` payload.
fn parse_embedding(payload: &Value) -> AqlResult<Vec<f32>> {
    let embedding = payload
        .get("embedding")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            AqlError::InvalidQuery(format!(
                "engram_embed payload missing 'embedding' array; got: {payload}"
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
    fn parse_embedding_ok() {
        let embedding: Vec<f64> = (0..768).map(|i| i as f64 * 0.001).collect();
        let payload = json!({ "embedding": embedding, "dimensions": 768 });
        let vec = parse_embedding(&payload).unwrap();
        assert_eq!(vec.len(), 768);
        assert!((vec[1] - 0.001_f32).abs() < 1e-5);
    }

    #[test]
    fn parse_embedding_missing_array() {
        let payload = json!({ "dimensions": 768 });
        assert!(parse_embedding(&payload).is_err());
    }
}
