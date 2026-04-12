//! LOOKUP statement handler. KEY-based exact match, also accepts WHERE for flexibility.

use aql_parser::ast::{LookupStmt, Predicate};
use rusqlite::types::Value as RusqValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::AqlResult;
use crate::memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
use crate::result::QueryResult;
use crate::sql::conditions::condition_to_sql;
use crate::sql::fields::resolve_field;
use crate::sql::serialize::rusqlite_to_json;
use crate::sql::values::value_to_rusqlite;

pub fn execute(conn: &Connection, stmt: &LookupStmt) -> AqlResult<QueryResult> {
    let table = aql_to_table(stmt.memory_type);
    let chunk_type = aql_to_chunk_memory_type(stmt.memory_type);

    let mut where_parts: Vec<String> = Vec::new();
    let mut params: Vec<RusqValue> = Vec::new();

    // Base conditions per table
    match table {
        EngramTable::Chunks | EngramTable::All => {
            where_parts.push("is_active = 1".into());
            if let Some(t) = chunk_type {
                where_parts.push("memory_type = ?".into());
                params.push(RusqValue::Text(t.into()));
            }
        }
        EngramTable::Tools | EngramTable::Observations => {
            where_parts.push("is_active = 1".into());
        }
        EngramTable::WorkingMemory => {
            where_parts.push("(expires_at IS NULL OR expires_at > datetime('now'))".into());
        }
    }

    match &stmt.predicate {
        Predicate::Key { field, value } => {
            let field_sql = resolve_field(field, table).to_sql();
            params.push(value_to_rusqlite(value));
            where_parts.push(format!("{} = ?", field_sql));
        }
        Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, &mut params));
            }
        }
        Predicate::All => {}
        Predicate::Like { .. } | Predicate::Pattern { .. } => {
            let mut result = QueryResult::success("Lookup", Vec::new());
            result.warnings.push(
                "LIKE and PATTERN predicates require vector search — deferred to Phase 2".into(),
            );
            return Ok(result);
        }
    }

    let where_clause = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let sql = format!(
        "SELECT * FROM {} {} LIMIT 100",
        table.as_sql_name(),
        where_clause
    );

    let mut prepared = conn.prepare(&sql)?;
    let column_names: Vec<String> = prepared
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();

    let rows = prepared.query_map(rusqlite::params_from_iter(params.iter()), |row| {
        let mut map = Map::new();
        for (i, name) in column_names.iter().enumerate() {
            let v: RusqValue = row.get(i)?;
            map.insert(name.clone(), rusqlite_to_json(v));
        }
        Ok(JsonValue::Object(map))
    })?;

    let mut data = Vec::new();
    for r in rows {
        data.push(r?);
    }

    Ok(QueryResult::success("Lookup", data))
}
