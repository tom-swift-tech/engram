//! RECALL statement handler.

use aql_parser::ast::{Modifiers, OrderBy, RecallStmt};
use rusqlite::types::Value as RusqValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::error::{AqlError, AqlResult};
use crate::memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
use crate::result::QueryResult;
use crate::sql::conditions::condition_to_sql;
use crate::sql::fields::resolve_field;
use crate::sql::serialize::rusqlite_to_json;
use crate::sql::values::value_to_rusqlite;

/// Result of building a WHERE clause. Callers use the deferred variant to
/// return a graceful empty result with a warning.
enum WhereResult {
    Built(Vec<String>),
    VectorSearchDeferred,
}

/// Build the WHERE clause parts (as a list of SQL fragments) and populate
/// the bind parameters. Shared between `execute` and `execute_aggregate`.
/// Returns an error if a Like/Pattern predicate is encountered.
fn build_where_clause(
    stmt: &RecallStmt,
    table: EngramTable,
    chunk_type: Option<&'static str>,
    params: &mut Vec<RusqValue>,
) -> AqlResult<WhereResult> {
    let mut where_parts: Vec<String> = Vec::new();

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
        aql_parser::ast::Predicate::All => {}
        aql_parser::ast::Predicate::Where { conditions } => {
            for cond in conditions {
                where_parts.push(condition_to_sql(cond, table, params));
            }
        }
        aql_parser::ast::Predicate::Key { field, value } => {
            let field_sql = resolve_field(field, table).to_sql();
            params.push(value_to_rusqlite(value));
            where_parts.push(format!("{} = ?", field_sql));
        }
        aql_parser::ast::Predicate::Like { .. } | aql_parser::ast::Predicate::Pattern { .. } => {
            return Ok(WhereResult::VectorSearchDeferred);
        }
    }

    Ok(WhereResult::Built(where_parts))
}

pub fn execute(conn: &Connection, stmt: &RecallStmt) -> AqlResult<QueryResult> {
    let table = aql_to_table(stmt.memory_type);
    let chunk_type = aql_to_chunk_memory_type(stmt.memory_type);

    let mut warnings: Vec<String> = Vec::new();

    // Phase 1 scope caveat: ALL silently maps to the `chunks` table only.
    // The design spec defines ALL as chunks + observations + working_memory,
    // but federation is not implemented yet. Warn so callers know.
    if stmt.memory_type == aql_parser::ast::MemoryType::All {
        warnings.push(
            "ALL memory type in Phase 1 queries the chunks table only; observations and working_memory tables are not included. Future phases may federate across tables."
                .into(),
        );
    }

    // AGGREGATE path — if modifiers have aggregate functions, build a
    // SELECT <aggs> FROM ... WHERE ... HAVING ... query instead of SELECT *.
    if let Some(aggs) = &stmt.modifiers.aggregate {
        if !aggs.is_empty() {
            return execute_aggregate(conn, stmt, table, chunk_type, aggs, warnings);
        }
    }

    let mut params: Vec<RusqValue> = Vec::new();

    let where_parts = match build_where_clause(stmt, table, chunk_type, &mut params)? {
        WhereResult::Built(parts) => parts,
        WhereResult::VectorSearchDeferred => {
            warnings.push(
                "LIKE and PATTERN predicates require vector search — deferred to Phase 2".into(),
            );
            let mut result = QueryResult::success("Recall", Vec::new());
            result.warnings = warnings;
            return Ok(result);
        }
    };

    // MIN_CONFIDENCE modifier maps to trust_score filter
    let mut where_parts = where_parts;
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

    // Extract chunk IDs for graph operations (requires id column)
    let chunk_ids: Vec<String> = data
        .iter()
        .filter_map(|row| {
            row.get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();

    let mut links: Option<Vec<crate::result::AqlLink>> = None;

    // WITH LINKS — attach metadata to the result
    if let Some(with) = &stmt.modifiers.with_links {
        let fetched = crate::statements::graph::fetch_links_for(conn, &chunk_ids, with)?;
        // Always populate the field (even if empty) when WITH LINKS was requested
        links = Some(fetched);
    }

    // FOLLOW LINKS — expand the result with related chunks
    if let Some(follow) = &stmt.modifiers.follow_links {
        let expanded_ids =
            crate::statements::graph::follow_links_expand(conn, &chunk_ids, follow)?;
        if !expanded_ids.is_empty() {
            // Fetch the expanded rows from chunks (limit the parameter list for safety)
            let safe_ids: Vec<String> = expanded_ids.into_iter().take(1000).collect();
            let placeholders: Vec<&str> = safe_ids.iter().map(|_| "?").collect();
            let sql = format!(
                "SELECT * FROM chunks WHERE id IN ({}) AND is_active = 1",
                placeholders.join(", ")
            );
            let mut prep = conn.prepare(&sql)?;
            let column_names: Vec<String> = prep
                .column_names()
                .into_iter()
                .map(String::from)
                .collect();
            let rows = prep.query_map(
                rusqlite::params_from_iter(safe_ids.iter()),
                |row| {
                    let mut map = Map::new();
                    for (i, name) in column_names.iter().enumerate() {
                        let v: RusqValue = row.get(i)?;
                        map.insert(name.clone(), rusqlite_to_json(v));
                    }
                    Ok(JsonValue::Object(map))
                },
            )?;
            let mut seen: std::collections::HashSet<String> = data
                .iter()
                .filter_map(|r| {
                    r.get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect();
            for r in rows {
                let row = r?;
                if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                    if seen.insert(id.to_string()) {
                        data.push(row);
                    }
                }
            }
        }
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
    result.links = links;
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
    // 1000-row safety cap — applies whether or not the user specified LIMIT.
    // This protects against runaway queries and matches the spec.
    match modifiers.limit {
        Some(n) => format!("LIMIT {}", n.min(1000)),
        None => "LIMIT 1000".into(),
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

fn execute_aggregate(
    conn: &Connection,
    stmt: &RecallStmt,
    table: EngramTable,
    chunk_type: Option<&'static str>,
    aggs: &[aql_parser::ast::AggregateFunc],
    mut warnings: Vec<String>,
) -> AqlResult<QueryResult> {
    use aql_parser::ast::AggregateFuncType;

    let mut params: Vec<RusqValue> = Vec::new();

    let where_parts = match build_where_clause(stmt, table, chunk_type, &mut params)? {
        WhereResult::Built(parts) => parts,
        WhereResult::VectorSearchDeferred => {
            let mut result = QueryResult::success("Recall", Vec::new());
            warnings.push(
                "LIKE/PATTERN with AGGREGATE is deferred to Phase 2 (vector search)".into(),
            );
            result.warnings = warnings;
            return Ok(result);
        }
    };

    // Build SELECT clause from aggregates
    let mut select_parts: Vec<String> = Vec::new();
    for agg in aggs {
        let func_name = match agg.func {
            AggregateFuncType::Count => "COUNT",
            AggregateFuncType::Sum => "SUM",
            AggregateFuncType::Avg => "AVG",
            AggregateFuncType::Min => "MIN",
            AggregateFuncType::Max => "MAX",
        };
        let field_sql = match &agg.field {
            None => "*".to_string(),
            Some(f) if f == "*" => "*".to_string(),
            Some(f) => resolve_field(f, table).to_sql(),
        };
        let alias = agg
            .alias
            .clone()
            .unwrap_or_else(|| format!("{}_value", func_name.to_lowercase()));

        // Runtime check: alias must be alphanumeric + underscore only
        // to prevent SQL injection via crafted alias names.
        if !alias.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(AqlError::InvalidQuery(format!(
                "AGGREGATE alias '{}' contains unsafe characters; expected alphanumeric+underscore only",
                alias
            )));
        }

        select_parts.push(format!("{}({}) AS {}", func_name, field_sql, alias));
    }

    let where_clause = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let mut sql = format!(
        "SELECT {} FROM {} {}",
        select_parts.join(", "),
        table.as_sql_name(),
        where_clause
    );

    // HAVING clause — operates on the aggregate aliases, which are computed
    // columns. The field names in HAVING are expected to match the alias
    // names from the SELECT clause, so we do NOT route them through
    // resolve_field (which would try to interpret them as column names).
    if let Some(having) = &stmt.modifiers.having {
        if !having.is_empty() {
            let mut having_parts: Vec<String> = Vec::new();
            for cond in having {
                let fragment = having_condition_to_sql(cond, &mut params)?;
                having_parts.push(fragment);
            }
            sql.push_str(&format!(" HAVING {}", having_parts.join(" AND ")));
        }
    }

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

    // HAVING filters result sets — if aggregate row doesn't satisfy HAVING,
    // SQLite returns no rows. A zero-row result from an AGGREGATE is a
    // meaningful result (not an error).
    let mut result = QueryResult::success("Recall", data);
    result.warnings = warnings;
    Ok(result)
}

/// Translate a HAVING condition to SQL. HAVING references aggregate aliases
/// which are computed columns — we do NOT apply field resolution (which would
/// try to rewrite aliases as json_extract paths).
fn having_condition_to_sql(
    cond: &aql_parser::ast::Condition,
    params: &mut Vec<RusqValue>,
) -> AqlResult<String> {
    use aql_parser::ast::{Condition, LogicalOp, Operator};

    match cond {
        Condition::Simple {
            field,
            operator,
            value,
            logical_op: _,
        } => {
            // Runtime injection guard: alias must be alphanumeric + underscore only.
            // debug_assert! is a no-op in release builds and is therefore not
            // sufficient as a security boundary.
            if !field.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(AqlError::InvalidQuery(format!(
                    "HAVING field '{}' contains unsafe characters; expected alphanumeric+underscore only",
                    field
                )));
            }
            let op_sql = match operator {
                Operator::Eq => "=",
                Operator::Ne => "!=",
                Operator::Gt => ">",
                Operator::Gte => ">=",
                Operator::Lt => "<",
                Operator::Lte => "<=",
                Operator::Contains
                | Operator::StartsWith
                | Operator::EndsWith
                | Operator::In => {
                    return Err(AqlError::InvalidQuery(format!(
                        "HAVING does not support operator {:?}; use =/!=/</>/<=/>= on aggregate aliases",
                        operator
                    )));
                }
            };
            params.push(value_to_rusqlite(value));
            Ok(format!("{} {} ?", field, op_sql))
        }
        Condition::Group {
            conditions,
            logical_op: _,
        } => {
            let mut parts: Vec<String> = Vec::new();
            for (i, c) in conditions.iter().enumerate() {
                if i > 0 {
                    let op = c.logical_op().unwrap_or(LogicalOp::And);
                    parts.push(match op {
                        LogicalOp::And => "AND".to_string(),
                        LogicalOp::Or => "OR".to_string(),
                    });
                }
                parts.push(having_condition_to_sql(c, params)?);
            }
            Ok(format!("({})", parts.join(" ")))
        }
    }
}

