//! engram-aql binary entrypoint

use clap::Parser;

#[derive(Parser)]
#[command(name = "engram-aql")]
#[command(version, about = "AQL query binary for Engram agent memory files")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(clap::Subcommand)]
enum Command {
    /// Run a single AQL query and print the JSON result
    Query {
        /// Path to the .engram SQLite file
        db_path: std::path::PathBuf,
        /// AQL query string
        query: String,
    },

    /// Open an interactive REPL for ad-hoc queries
    Repl {
        /// Path to the .engram SQLite file
        db_path: std::path::PathBuf,
    },

    /// Run as an MCP stdio server
    Mcp {
        /// Path to the .engram SQLite file
        db_path: std::path::PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    // tracing to stderr so JSON on stdout stays clean (MCP/query modes)
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Command::Query { db_path, query } => {
            println!("TODO: query subcommand — db={:?} query={}", db_path, query);
            Ok(())
        }
        Command::Repl { db_path } => {
            println!("TODO: repl subcommand — db={:?}", db_path);
            Ok(())
        }
        Command::Mcp { db_path } => {
            println!("TODO: mcp subcommand — db={:?}", db_path);
            Ok(())
        }
    }
}
