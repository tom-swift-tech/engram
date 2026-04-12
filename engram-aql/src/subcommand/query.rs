//! `engram-aql query` — one-shot query execution.
//!
//! Opens the `.engram` file, runs a single AQL query, writes the pretty-
//! printed JSON result to stdout, and exits non-zero if the query failed.

use std::path::Path;
use std::process::exit;

use crate::executor::Executor;

/// Run the query subcommand.
///
/// Writes the pretty-printed JSON result to stdout. Calls `exit(1)` if the
/// query returned an error result (`success: false`) so the shell can detect
/// failures. Returns `Err` only for I/O or serialization failures.
pub fn run(db_path: &Path, query: &str) -> anyhow::Result<()> {
    let exec = Executor::open(db_path)?;
    let result = exec.query(query)?;

    let json = serde_json::to_string_pretty(&result)?;
    println!("{}", json);

    if !result.success {
        exit(1);
    }
    Ok(())
}
