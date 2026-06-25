//! Bridge spawn + embed round-trip test.
//!
//! **Gated:** if `engram-mcp` is not discoverable (no `ENGRAM_MCP_CMD` and not
//! on PATH), this test prints a skip message and returns early — CI without the
//! built TypeScript bin stays green (same philosophy as the L3 cross-process
//! suite in the repo root).
//!
//! When `engram-mcp` IS present (locally, set
//! `ENGRAM_MCP_CMD="node /abs/path/to/dist/mcp-server.js"`):
//!   - Spawns the bridge pointed at a temp `.engram` DB.
//!   - Asserts `embed_query("deploy pipeline")` returns a 768-length Vec<f32>
//!     of finite values.
//!   - Asserts two calls with different text yield different vectors.

mod common;

use engram_aql::bridge::child::resolve_engram_mcp_cmd;
use engram_aql::bridge::Bridge;
use tempfile::NamedTempFile;

/// Create a minimal `.engram` SQLite file for the bridge to open.
///
/// `engram-mcp` calls `Engram.open()` on it, which initialises the schema if
/// the tables are absent. We seed the schema ourselves so the file is a valid
/// `.engram` that Engram can recognise immediately without running any
/// additional TS migration step.
fn make_temp_engram() -> NamedTempFile {
    let file = NamedTempFile::with_suffix(".engram").unwrap();
    let conn = rusqlite::Connection::open(file.path()).unwrap();
    conn.execute_batch(common::SCHEMA_SQL).unwrap();
    drop(conn);
    file
}

#[test]
fn bridge_embed_query_returns_768_finite_floats() {
    // ── gate ────────────────────────────────────────────────────────────────
    let cmd = resolve_engram_mcp_cmd(None);
    if cmd.is_none() {
        eprintln!(
            "[bridge_embed] SKIP — engram-mcp not discoverable. \
             Set ENGRAM_MCP_CMD=\"node /abs/path/to/dist/mcp-server.js\" to run."
        );
        return;
    }
    let cmd = cmd.unwrap();

    // ── setup ────────────────────────────────────────────────────────────────
    let db_file = make_temp_engram();
    let db_path = db_file.path();

    let mut bridge = Bridge::new(cmd, db_path).expect("bridge should start");

    // ── embed: "deploy pipeline" ─────────────────────────────────────────────
    let vec1 = bridge
        .embed_query("deploy pipeline")
        .expect("embed_query should succeed");

    assert_eq!(
        vec1.len(),
        768,
        "expected 768-dimensional embedding, got {}",
        vec1.len()
    );
    assert!(
        vec1.iter().all(|x| x.is_finite()),
        "all embedding values must be finite"
    );

    // ── embed: different text yields a different vector ───────────────────────
    let vec2 = bridge
        .embed_query("completely unrelated topic about cooking")
        .expect("second embed_query should succeed");

    assert_eq!(vec2.len(), 768);

    // Vectors for different text must differ. Compare elementwise — exact
    // equality for two independent embeddings is astronomically unlikely.
    let identical = vec1.iter().zip(vec2.iter()).all(|(a, b)| a == b);
    assert!(!identical, "different texts must produce different vectors");
}
