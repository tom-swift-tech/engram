//! engram-aql — AQL query executor for Engram memory files

pub mod error;
pub mod schema;

pub use error::{AqlError, AqlResult, SchemaError};
pub use schema::verify_schema;
