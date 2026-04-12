//! Top-level AQL executor — parses, dispatches, and returns results.

use std::path::Path;
use std::time::Instant;

use aql_parser::ast::Statement;
use rusqlite::Connection;

use crate::error::AqlResult;
use crate::result::QueryResult;
use crate::schema::verify_schema;
use crate::statements;

pub struct Executor {
    conn: Connection,
}

impl Executor {
    /// Build an Executor from an existing connection. Verifies schema.
    pub fn from_connection(conn: Connection) -> AqlResult<Self> {
        verify_schema(&conn)?;
        Ok(Self { conn })
    }

    /// Open a `.engram` SQLite file and build an Executor.
    pub fn open(path: &Path) -> AqlResult<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// Execute a single AQL query string.
    pub fn query(&self, aql: &str) -> AqlResult<QueryResult> {
        let start = Instant::now();

        let stmt = match aql_parser::parse(aql) {
            Ok(s) => s,
            Err(e) => {
                let mut result = QueryResult::error("Unknown", format!("parse error: {}", e));
                result.timing_ms = start.elapsed().as_millis() as u64;
                return Ok(result);
            }
        };

        let mut result = self.dispatch(&stmt)?;
        result.timing_ms = start.elapsed().as_millis() as u64;
        Ok(result)
    }

    fn dispatch(&self, stmt: &Statement) -> AqlResult<QueryResult> {
        match stmt {
            Statement::Recall(r) => statements::recall::execute(&self.conn, r),

            // Writes — rejected at dispatch time
            Statement::Store(_)
            | Statement::Update(_)
            | Statement::Forget(_)
            | Statement::Link(_)
            | Statement::Reflect(_) => Ok(statements::write_reject::reject(stmt)),

            // Other reads — implemented in later tasks
            _ => Ok(QueryResult::error(
                statement_name(stmt),
                format!("statement not yet implemented: {}", statement_name(stmt)),
            )),
        }
    }
}

fn statement_name(stmt: &Statement) -> &'static str {
    match stmt {
        Statement::Pipeline(_) => "Pipeline",
        Statement::Reflect(_) => "Reflect",
        Statement::Scan(_) => "Scan",
        Statement::Recall(_) => "Recall",
        Statement::Lookup(_) => "Lookup",
        Statement::Load(_) => "Load",
        Statement::Store(_) => "Store",
        Statement::Update(_) => "Update",
        Statement::Forget(_) => "Forget",
        Statement::Link(_) => "Link",
    }
}
