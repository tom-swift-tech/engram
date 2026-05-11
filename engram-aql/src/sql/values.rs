//! AQL Value → rusqlite::types::Value conversion.

use aql_parser::ast::Value as AqlValue;
use rusqlite::types::Value as RusqValue;

pub fn value_to_rusqlite(value: &AqlValue) -> RusqValue {
    match value {
        AqlValue::Null => RusqValue::Null,
        AqlValue::Bool(b) => RusqValue::Integer(if *b { 1 } else { 0 }),
        AqlValue::Int(n) => RusqValue::Integer(*n),
        AqlValue::Float(f) => RusqValue::Real(*f),
        AqlValue::String(s) => RusqValue::Text(s.clone()),
        AqlValue::Variable(v) => {
            // Variables aren't resolved at this layer — higher layers substitute
            // values before calling us. If we see one here, it's a bug in the caller.
            RusqValue::Text(format!("${}", v))
        }
        AqlValue::Array(_) => {
            // Arrays are handled by the IN operator directly; this path is
            // only hit if an array is used in an invalid context.
            RusqValue::Null
        }
    }
}
