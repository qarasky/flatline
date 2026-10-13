use std::path::PathBuf;

/// Runtime configuration, mirroring the Node backend's environment so the
/// same compose files keep working.
#[derive(Debug, Clone)]
pub struct Config {
    /// Data directory (SQLite file, uploads, the initial token file).
    pub data_dir: PathBuf,
    /// Listen port. 3001 is the contract the Cloudflare Tunnel uses.
    pub port: u16,
    /// Bind address. 0.0.0.0 by default so containers work unchanged.
    pub host: String,
    /// Directory of the built SPA. Served when it exists.
    pub web_dist: PathBuf,
    /// Public origin used in provisioning docs and scripts
    /// (`https://uptime.example`). Empty falls back to the request's Host.
    pub public_url: Option<String>,
    /// Directory holding the agent binaries, `VERSION` and `sha256sums`
    /// served under `/agent/*`.
    pub agent_dir: PathBuf,
}

impl Config {
    /// Read configuration from the environment, with the same names the
    /// Node backend used where they exist.
    pub fn from_env() -> Self {
        let data_dir = std::env::var("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data"));

        let port = std::env::var("PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(3001);

        let host = std::env::var("UPTIME_KUMA_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

        let web_dist = std::env::var("FLATLINE_WEB_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/app/dashboard"));

        let public_url = std::env::var("FLATLINE_PUBLIC_URL")
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty());

        let agent_dir = std::env::var("FLATLINE_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/app/agent"));

        Self {
            data_dir,
            port,
            host,
            web_dist,
            public_url,
            agent_dir,
        }
    }
}
