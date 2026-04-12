//! RECALL statement handler.

use aql_parser::ast::{Modifiers, OrderBy, Predicate, RecallStmt};
use rusqlite::types::Value as RusqValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::AqlResult;
use crate::memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
use crate::result::QueryResult;
use crate::sql::conditions::condition_to_sql;
use crate::sql::fields::resolve_field;
use crate::sql::values::value_to_rusqlite;

pub fn execute(conn: &Connection, stmt: &RecallStmt) -> AqlResult<QueryResult> {
    let table = aql_to_table(stmt.memory_type);
    let chunk_type = aql_to_chunk_memory_type(stmt.memory_type);

    let mut where_parts: Vec<String> = Vec::new();
    let mut params: Vec<RusqValue> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

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

    // Predicate conditions
    match &stmt.predicate {
        Predicate::All => {}
        Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, &mut params));
            }
        }
        Predicate::Key { field, value } => {
            // KEY is more of a LOOKUP feature, but RECALL allows it per grammar.
            // Treat KEY exactly like a simple WHERE field = value.
            let field_sql = resolve_field(field, table).to_sql();
            params.push(value_to_rusqlite(value));
            where_parts.push(format!("{} = ?", field_sql));
        }
        Predicate::Like { .. } | Predicate::Pattern { .. } => {
            warnings.push(
                "LIKE and PATTERN predicates require vector search — deferred to Phase 2"
                    .into(),
            );
            // Return early with a graceful empty result
            let mut result = QueryResult::success("Recall", Vec::new());
            result.warnings = warnings;
            return Ok(result);
        }
    }

    // MIN_CONFIDENCE modifier maps to trust_score filter
    if let Some(min_conf) = stmt.modifiers.min_confidence {
        where_parts.push("trust_score >= ?".into());
        params.push(RusqValue::Real(min_conf as f64));
    }

    // Modifier warnings (non-fatal)
    warnings.extend(collect_modifier_warnings(&stmt.modifiers));

    // Build SELECT
    let where_clause = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let order_clause = order_by_clause(&stmt.modifiers.order_by, table);
    let limit_clause = limit_clause(&stmt.modifiers);

    let sql = format!(
        "SELECT * FROM {} {} {} {}",
        table.as_sql_name(),
        where_clause,
        order_clause,
        limit_clause,
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
            let value: RusqValue = row.get(i)?;
            map.insert(name.clone(), rusqlite_to_json(value));
        }
        Ok(JsonValue::Object(map))
    })?;

    let mut data: Vec<JsonValue> = Vec::new();
    for r in rows {
        data.push(r?);
    }

    // Apply RETURN field selection post-query
    if let Some(fields) = &stmt.modifiers.return_fields {
        if !fields.iter().any(|f| f == "*") {
            data = data
                .into_iter()
                .map(|row| filter_fields(row, fields))
                .collect();
        }
    }

    let mut result = QueryResult::success("Recall", data);
    result.warnings = warnings;
    Ok(result)
}

fn order_by_clause(order: &Option<OrderBy>, table: EngramTable) -> String {
    match order {
        Some(ob) => {
            let field = resolve_field(&ob.field, table).to_sql();
            let dir = if ob.ascending { "ASC" } else { "DESC" };
            format!("ORDER BY {} {}", field, dir)
        }
        None => String::new(),
    }
}

fn limit_clause(modifiers: &Modifiers) -> String {
    match modifiers.limit {
        Some(n) => format!("LIMIT {}", n),
        None => "LIMIT 1000".into(), // safety cap
    }
}

fn collect_modifier_warnings(modifiers: &Modifiers) -> Vec<String> {
    let mut warnings = Vec::new();
    if modifiers.scope.is_some() {
        warnings.push(
            "SCOPE modifier accepted but not enforced (schema lacks scope column)".into(),
        );
    }
    if modifiers.namespace.is_some() {
        warnings.push(
            "NAMESPACE modifier accepted but not enforced (schema lacks namespace column)"
                .into(),
        );
    }
    if modifiers.ttl.is_some() {
        warnings.push("TTL modifier accepted but not enforced (engram has no TTL)".into());
    }
    if modifiers.timeout.is_some() {
        warnings.push("TIMEOUT modifier accepted but not enforced in Phase 1".into());
    }
    warnings
}

fn filter_fields(row: JsonValue, fields: &[String]) -> JsonValue {
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
}

pub(crate) fn rusqlite_to_json(value: RusqValue) -> JsonValue {
    match value {
        RusqValue::Null => JsonValue::Null,
        RusqValue::Integer(n) => JsonValue::Number(n.into()),
        RusqValue::Real(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        RusqValue::Text(s) => JsonValue::String(s),
        RusqValue::Blob(_) => JsonValue::Null, // don't serialize binary
    }
}
