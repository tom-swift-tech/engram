//! SQL building utilities for AQL query translation.
//!
//! This module is consumed by every statement handler that needs to turn
//! AQL predicates into rusqlite WHERE clauses.

pub mod conditions;
pub mod fields;
pub mod values;
