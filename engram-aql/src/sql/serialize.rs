//! Shared serialization helpers for statement handlers.
//!
//! Converts `rusqlite::types::Value` into `serde_json::Value` for returning
//! query results. Used by every statement handler that emits row data.

use rusqlite::types::Value as RusqValue;
use serde_json::Value as JsonValue;

/// Convert a rusqlite value into a JSON value suitable for QueryResult.data.
/// Blobs and NaN/Inf floats become `null`.
pub fn rusqlite_to_json(value: RusqValue) -> JsonValue {
    match value {
        RusqValue::Null => JsonValue::Null,
        RusqValue::Integer(n) => JsonValue::Number(n.into()),
        RusqValue::Real(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        RusqValue::Text(s) => JsonValue::String(s),
        RusqValue::Blob(_) => JsonValue::Null,
    }
}
