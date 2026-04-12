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
    /// Field cannot be resolved against this table's columns AND there is
    /// no JSON bag column to fall back to. Produces a SQL expression that
    /// always evaluates to NULL so queries fail cleanly (no rows matched)
    /// instead of silently returning wrong data.
    Unresolvable {
        table: EngramTable,
        field: String,
    },
}

impl FieldRef {
    pub fn to_sql(&self) -> String {
        match self {
            FieldRef::Column(name) => (*name).to_string(),
            FieldRef::JsonPath { column, path } => {
                // The AQL grammar (aql.pest) restricts field paths to
                // [A-Za-z0-9_.-]. This debug_assert catches any future caller
                // that bypasses the grammar.
                debug_assert!(
                    path.chars().all(|c| {
                        c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'
                    }),
                    "json_extract path contains unsafe characters: {}",
                    path
                );
                format!("json_extract({}, '$.{}')", column, path)
            }
            FieldRef::Unresolvable { .. } => {
                // Expression that compares as NULL against any value,
                // ensuring the query returns no rows rather than a silent
                // bogus match.
                "NULL".to_string()
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
    "superseded_by",
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
    let known: &[&str] = match table {
        EngramTable::Chunks | EngramTable::All => CHUNK_COLUMNS,
        EngramTable::Tools => TOOLS_COLUMNS,
        EngramTable::Observations => OBSERVATION_COLUMNS,
        EngramTable::WorkingMemory => WORKING_MEMORY_COLUMNS,
    };

    for col in known {
        if *col == field {
            return FieldRef::Column(col);
        }
    }

    // Fallback: json_extract on the "JSON bag" column when one exists.
    // Tables without a JSON bag column (Observations, Tools) return Unresolvable
    // so queries fail cleanly instead of silently matching NULL.
    // Note: tools.tags is a JSON array (not a bag), so it is also Unresolvable.
    match table {
        EngramTable::Chunks | EngramTable::All => FieldRef::JsonPath {
            column: "text",
            path: field.to_string(),
        },
        EngramTable::WorkingMemory => FieldRef::JsonPath {
            column: "data_json",
            path: field.to_string(),
        },
        EngramTable::Tools => FieldRef::Unresolvable {
            table,
            field: field.to_string(),
        },
        EngramTable::Observations => FieldRef::Unresolvable {
            table,
            field: field.to_string(),
        },
    }
}
