//! engram-aql — AQL query executor for Engram memory files

pub mod error;
pub mod executor;
pub mod memory_map;
pub mod result;
pub mod schema;
pub mod sql;
pub mod statements;

pub use error::{AqlError, AqlResult, SchemaError};
pub use executor::Executor;
pub use memory_map::{aql_to_chunk_memory_type, aql_to_table, EngramTable};
pub use result::{AqlLink, QueryResult};
pub use schema::verify_schema;
