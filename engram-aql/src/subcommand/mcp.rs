//! `engram-aql mcp` — stdio JSON-RPC server subcommand.

use std::path::Path;

use anyhow::Result;

pub fn run(db_path: &Path) -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(crate::mcp::run(db_path))
}
