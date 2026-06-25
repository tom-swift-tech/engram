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
        /// Bind a variable for LIKE $name / PATTERN $name (repeatable).
        /// VALUE is parsed as JSON, falling back to a plain string:
        ///   --var q=hello            → string "hello" (embedded server-side)
        ///   --var q='[0.1,0.2,0.3]'  → precomputed embedding probe
        #[arg(long = "var", value_name = "NAME=VALUE")]
        vars: Vec<String>,
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
        Command::Query {
            db_path,
            query,
            vars,
        } => {
            let success = engram_aql::subcommand::query::run(&db_path, &query, &vars)?;
            if !success {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Repl { db_path } => engram_aql::subcommand::repl::run(&db_path),
        Command::Mcp { db_path } => engram_aql::subcommand::mcp::run(&db_path),
    }
}
