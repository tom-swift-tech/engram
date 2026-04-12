//! Condition → SQL WHERE fragment translation.

use aql_parser::ast::{Condition, LogicalOp, Operator, Value};
use rusqlite::types::Value as RusqValue;

use crate::memory_map::EngramTable;
use crate::sql::fields::resolve_field;
use crate::sql::values::value_to_rusqlite;

/// Translate an AQL Condition into a SQL fragment and append bind parameters.
///
/// Returns the SQL fragment (e.g., "context = ?", "(a = ? AND b > ?)").
/// Appends bind values to `params` in left-to-right order.
pub fn condition_to_sql(
    cond: &Condition,
    table: EngramTable,
    params: &mut Vec<RusqValue>,
) -> String {
    match cond {
        Condition::Simple {
            field,
            operator,
            value,
            logical_op: _,
        } => simple_to_sql(field, *operator, value, table, params),

        Condition::Group {
            conditions,
            logical_op: _,
        } => group_to_sql(conditions, table, params),
    }
}

fn simple_to_sql(
    field: &str,
    operator: Operator,
    value: &Value,
    table: EngramTable,
    params: &mut Vec<RusqValue>,
) -> String {
    let field_sql = resolve_field(field, table).to_sql();

    match operator {
        Operator::Eq => {
            params.push(value_to_rusqlite(value));
            format!("{} = ?", field_sql)
        }
        Operator::Ne => {
            params.push(value_to_rusqlite(value));
            format!("{} != ?", field_sql)
        }
        Operator::Gt => {
            params.push(value_to_rusqlite(value));
            format!("{} > ?", field_sql)
        }
        Operator::Gte => {
            params.push(value_to_rusqlite(value));
            format!("{} >= ?", field_sql)
        }
        Operator::Lt => {
            params.push(value_to_rusqlite(value));
            format!("{} < ?", field_sql)
        }
        Operator::Lte => {
            params.push(value_to_rusqlite(value));
            format!("{} <= ?", field_sql)
        }
        Operator::Contains => {
            let s = string_or_empty(value);
            params.push(RusqValue::Text(format!("%{}%", s)));
            format!("{} LIKE ?", field_sql)
        }
        Operator::StartsWith => {
            let s = string_or_empty(value);
            params.push(RusqValue::Text(format!("{}%", s)));
            format!("{} LIKE ?", field_sql)
        }
        Operator::EndsWith => {
            let s = string_or_empty(value);
            params.push(RusqValue::Text(format!("%{}", s)));
            format!("{} LIKE ?", field_sql)
        }
        Operator::In => {
            if let Value::Array(items) = value {
                let placeholders: Vec<&str> = (0..items.len()).map(|_| "?").collect();
                for item in items {
                    params.push(value_to_rusqlite(item));
                }
                format!("{} IN ({})", field_sql, placeholders.join(", "))
            } else {
                // Non-array with IN — treat as equality for graceful fallback.
                params.push(value_to_rusqlite(value));
                format!("{} = ?", field_sql)
            }
        }
    }
}

fn group_to_sql(
    conditions: &[Condition],
    table: EngramTable,
    params: &mut Vec<RusqValue>,
) -> String {
    if conditions.is_empty() {
        return "1=1".to_string();
    }

    // aql-parser carries logical_op on each condition (except the first),
    // describing how it joins to the previous sibling. We respect that.
    let mut parts: Vec<String> = Vec::with_capacity(conditions.len() * 2);
    for (i, c) in conditions.iter().enumerate() {
        if i > 0 {
            let op = c.logical_op().unwrap_or(LogicalOp::And);
            parts.push(match op {
                LogicalOp::And => "AND".to_string(),
                LogicalOp::Or => "OR".to_string(),
            });
        }
        parts.push(condition_to_sql(c, table, params));
    }
    format!("({})", parts.join(" "))
}

fn string_or_empty(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}
