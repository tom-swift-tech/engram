//! `engram-aql query` — one-shot query execution.
//!
//! Opens the `.engram` file, runs a single AQL query, writes the pretty-
//! printed JSON result to stdout, and returns the `success` flag so `main`
//! can decide on the process exit code. This split lets the `Executor`
//! (and its underlying SQLite connection) drop normally before the process
//! terminates — `std::process::exit` would skip Drop.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;
use serde_json::Value;

use crate::executor::Executor;

/// Run the query subcommand. Returns `Ok(true)` if the query succeeded,
/// `Ok(false)` if it returned an error result. Transport-level errors
/// (opening the DB, I/O) are propagated as `Err`.
///
/// `raw_vars` are `NAME=VALUE` strings from repeated `--var` flags, bound as
/// AQL `$NAME` variables for LIKE/PATTERN. VALUE is parsed as JSON, falling
/// back to a plain JSON string when it is not valid JSON.
pub fn run(db_path: &Path, query: &str, raw_vars: &[String]) -> anyhow::Result<bool> {
    let vars = parse_vars(raw_vars)?;

    let exec = Executor::open(db_path)?;
    let result = exec.query_with_vars(query, vars)?;

    let json = serde_json::to_string_pretty(&result)?;
    println!("{}", json);

    Ok(result.success)
    // `exec` drops here, closing the SQLite connection cleanly.
}

/// Parse `NAME=VALUE` strings into a variable map. Splits on the FIRST `=`.
/// VALUE is parsed as JSON; if that fails it is treated as a plain string
/// (so `--var q=hello` binds the string "hello").
fn parse_vars(raw_vars: &[String]) -> anyhow::Result<BTreeMap<String, Value>> {
    let mut vars = BTreeMap::new();
    for raw in raw_vars {
        let (name, value) = raw
            .split_once('=')
            .with_context(|| format!("invalid --var '{raw}': expected NAME=VALUE"))?;
        if name.is_empty() {
            anyhow::bail!("invalid --var '{raw}': variable name is empty");
        }
        let parsed = serde_json::from_str::<Value>(value)
            .unwrap_or_else(|_| Value::String(value.to_string()));
        vars.insert(name.to_string(), parsed);
    }
    Ok(vars)
}
