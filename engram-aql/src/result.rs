//! Result types returned from AQL query execution.
//!
//! `QueryResult` is the top-level return value for every AQL statement. It
//! serializes to the JSON shape documented in the spec, with unused fields
//! suppressed so simple queries produce clean output.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub success: bool,
    pub statement: String,
    pub data: Vec<serde_json::Value>,
    pub count: usize,
    pub timing_ms: u64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub warnings: Vec<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<AqlLink>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_stages: Option<usize>,
}

impl QueryResult {
    /// Build a successful result with the given statement name and data rows.
    pub fn success(statement: impl Into<String>, data: Vec<serde_json::Value>) -> Self {
        let count = data.len();
        Self {
            success: true,
            statement: statement.into(),
            data,
            count,
            timing_ms: 0,
            error: None,
            warnings: Vec::new(),
            links: None,
            pipeline_stages: None,
        }
    }

    /// Build an error result with the given statement name and message.
    pub fn error(statement: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            success: false,
            statement: statement.into(),
            data: Vec::new(),
            count: 0,
            timing_ms: 0,
            error: Some(message.into()),
            warnings: Vec::new(),
            links: None,
            pipeline_stages: None,
        }
    }

    /// Append a warning to the result. Useful for documenting accepted-but-
    /// unsupported modifiers (SCOPE, NAMESPACE, TTL, TIMEOUT).
    pub fn with_warning(mut self, warning: impl Into<String>) -> Self {
        self.warnings.push(warning.into());
        self
    }
}

/// A link between two Engram entities, returned from queries using
/// the `WITH LINKS` modifier.
#[derive(Debug, Clone, Serialize)]
pub struct AqlLink {
    pub source_id: String,
    pub target_id: String,
    pub link_type: String,
    pub confidence: f64,
}
