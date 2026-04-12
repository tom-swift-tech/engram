//! engram-aql — AQL query executor for Engram memory files

pub mod error;

// Re-export the main public API as it gets built out in later tasks
pub use error::{AqlError, AqlResult, SchemaError};
