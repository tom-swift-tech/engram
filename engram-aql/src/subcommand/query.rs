//! `engram-aql query` — one-shot query execution.
//!
//! Opens the `.engram` file, runs a single AQL query, writes the pretty-
//! printed JSON result to stdout, and returns the `success` flag so `main`
//! can decide on the process exit code. This split lets the `Executor`
//! (and its underlying SQLite connection) drop normally before the process
//! terminates — `std::process::exit` would skip Drop.

use std::path::Path;

use crate::executor::Executor;

/// Run the query subcommand. Returns `Ok(true)` if the query succeeded,
/// `Ok(false)` if it returned an error result. Transport-level errors
/// (opening the DB, I/O) are propagated as `Err`.
pub fn run(db_path: &Path, query: &str) -> anyhow::Result<bool> {
    let exec = Executor::open(db_path)?;
    let result = exec.query(query)?;

    let json = serde_json::to_string_pretty(&result)?;
    println!("{}", json);

    Ok(result.success)
    // `exec` drops here, closing the SQLite connection cleanly.
}
