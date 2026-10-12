use tracing_subscriber::{EnvFilter, fmt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // `flatline-backend import --from <old.db> [--data-dir ./data] [--force]`
    // is the one-time migration entry point; everything else boots the
    // server.
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("import") => flatline_backend::import::run_cli(&args[1..]).await,
        Some(other) => {
            eprintln!("unknown command: {other}");
            eprintln!(
                "usage: flatline-backend [import --from <old.db> [--data-dir ./data] [--force]]"
            );
            std::process::exit(2);
        }
        None => flatline_backend::run().await,
    }
}
