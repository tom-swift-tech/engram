//! Field resolution: AQL field names → SQL column expressions.
//!
//! Fields that match a known column on the target table are used directly.
//! Fields that don't match are assumed to be JSON-stored inside the table's
//! text/data_json column and resolved via json_extract.

use crate::memory_map::EngramTable;

pub enum FieldRef {
    /// Direct column reference
    Column(&'static str),
    /// json_extract(<column>, '$.<path>')
    JsonPath {
        column: &'static str,
        path: String,
    },
}

impl FieldRef {
    pub fn to_sql(&self) -> String {
        match self {
            FieldRef::Column(name) => (*name).to_string(),
            FieldRef::JsonPath { column, path } => {
                format!("json_extract({}, '$.{}')", column, path)
            }
        }
    }
}

const CHUNK_COLUMNS: &[&str] = &[
    "id",
    "text",
    "memory_type",
    "source",
    "source_uri",
    "context",
    "source_type",
    "trust_score",
    "verified_by_user",
    "event_time",
    "event_time_end",
    "temporal_label",
    "text_hash",
    "created_at",
    "updated_at",
    "reflected_at",
    "is_active",
];

const TOOLS_COLUMNS: &[&str] = &[
    "id",
    "name",
    "description",
    "api_url",
    "ranking",
    "tags",
    "namespace",
    "scope",
    "created_at",
    "updated_at",
    "is_active",
];

const OBSERVATION_COLUMNS: &[&str] = &[
    "id",
    "summary",
    "source_chunks",
    "source_entities",
    "domain",
    "topic",
    "synthesized_at",
    "last_refreshed",
    "refresh_count",
    "is_active",
];

const WORKING_MEMORY_COLUMNS: &[&str] = &[
    "id",
    "task_id",
    "scope",
    "data_json",
    "seed_query",
    "topic_embedding",
    "updated_at",
    "expires_at",
];

pub fn resolve_field(field: &str, table: EngramTable) -> FieldRef {
    let (known, json_col) = match table {
        EngramTable::Chunks | EngramTable::All => (CHUNK_COLUMNS, "text"),
        EngramTable::Tools => (TOOLS_COLUMNS, "tags"),
        EngramTable::Observations => (OBSERVATION_COLUMNS, "source_chunks"),
        EngramTable::WorkingMemory => (WORKING_MEMORY_COLUMNS, "data_json"),
    };

    for col in known {
        if *col == field {
            return FieldRef::Column(col);
        }
    }

    FieldRef::JsonPath {
        column: json_col,
        path: field.to_string(),
    }
}
