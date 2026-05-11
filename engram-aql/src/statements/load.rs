//! LOAD FROM TOOLS statement handler.

use aql_parser::ast::{LoadStmt, Predicate};
use rusqlite::types::Value as RusqValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::AqlResult;
use crate::memory_map::EngramTable;
use crate::result::QueryResult;
use crate::sql::conditions::condition_to_sql;
use crate::sql::fields::resolve_field;
use crate::sql::serialize::rusqlite_to_json;
use crate::sql::values::value_to_rusqlite;

pub fn execute(conn: &Connection, stmt: &LoadStmt) -> AqlResult<QueryResult> {
    let table = EngramTable::Tools;
    let mut where_parts: Vec<String> = vec!["is_active = 1".into()];
    let mut params: Vec<RusqValue> = Vec::new();

    match &stmt.predicate {
        Predicate::All => {}
        Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, &mut params));
            }
        }
        Predicate::Key { field, value } => {
            let field_sql = resolve_field(field, table).to_sql();
            params.push(value_to_rusqlite(value));
            where_parts.push(format!("{} = ?", field_sql));
        }
        Predicate::Like { .. } | Predicate::Pattern { .. } => {
            let mut result = QueryResult::success("Load", Vec::new());
            result
                .warnings
                .push("LIKE/PATTERN on TOOLS deferred to Phase 2".into());
            return Ok(result);
        }
    }

    let limit = stmt.modifiers.limit.unwrap_or(10).min(1000);
    let sql = format!(
        "SELECT * FROM tools WHERE {} ORDER BY ranking DESC LIMIT {}",
        where_parts.join(" AND "),
        limit
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

    // Apply RETURN field selection post-query
    if let Some(fields) = &stmt.modifiers.return_fields {
        if !fields.iter().any(|f| f == "*") {
            data = data
                .into_iter()
                .map(|row| {
                    let JsonValue::Object(obj) = row else {
                        return row;
                    };
                    let mut filtered = Map::new();
                    for field in fields {
                        if let Some(v) = obj.get(field) {
                            filtered.insert(field.clone(), v.clone());
                        }
                    }
                    JsonValue::Object(filtered)
                })
                .collect();
        }
    }

    Ok(QueryResult::success("Load", data))
}
