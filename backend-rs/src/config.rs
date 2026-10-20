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
    /// Root of dedicated backup bundle storage (office mirror mount). None
    /// keeps backup storage disabled; the API reports 503 rather than
    /// falling back to the application data directory.
    pub backup_dir: Option<PathBuf>,
    /// How long heartbeats are kept, in days. 0 keeps them forever.
    ///
    /// Every check writes a heartbeat row, so without retention a monitor's
    /// history grows without bound (about 1.58M rows per monitor per year at
    /// a 20s interval). The read paths stay inside the window: uptime
    /// windows are at most 30 days, badges and status pages use 24h, and the
    /// heartbeat list is capped by its `limit`.
    pub heartbeat_retention_days: i64,
}

impl Config {
    /// Read configuration from the environment, with the same names the
    /// Node backend used where they exist.
    ///
    /// A set but unparseable value is a startup error naming the variable:
    /// silently listening on the default port, or keeping heartbeats for
    /// the default 90 days when the operator asked for 7, is worse than
    /// refusing to boot. Unset (or empty) values take the defaults.
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// [`Config::from_env`] over any variable source (tests pass a map).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let set = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };

        let data_dir = set("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("./data"));

        let port = match set("PORT") {
            Some(raw) => raw
                .parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or_else(|| {
                    anyhow::anyhow!("PORT must be a port number between 1 and 65535, got {raw:?}")
                })?,
            None => 3001,
        };

        let host = set("UPTIME_KUMA_HOST").unwrap_or_else(|| "0.0.0.0".to_string());

        let web_dist = set("FLATLINE_WEB_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/app/dashboard"));

        let public_url = set("FLATLINE_PUBLIC_URL");

        let agent_dir = set("FLATLINE_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/app/agent"));

        let backup_dir = set("FLATLINE_BACKUP_DIR").map(PathBuf::from);

        let heartbeat_retention_days = match set("FLATLINE_HEARTBEAT_RETENTION_DAYS") {
            Some(raw) => raw
                .parse::<i64>()
                .ok()
                .filter(|days| *days >= 0)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "FLATLINE_HEARTBEAT_RETENTION_DAYS must be a whole number of days \
                     (0 keeps heartbeats forever), got {raw:?}"
                    )
                })?,
            None => crate::heartbeats::DEFAULT_RETENTION_DAYS,
        };

        Ok(Self {
            data_dir,
            port,
            host,
            web_dist,
            public_url,
            agent_dir,
            backup_dir,
            heartbeat_retention_days,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(vars: &[(&str, &str)]) -> anyhow::Result<Config> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults_apply_when_unset_or_empty() {
        let config = config(&[("PORT", ""), ("FLATLINE_HEARTBEAT_RETENTION_DAYS", " ")]).unwrap();
        assert_eq!(config.port, 3001);
        assert_eq!(
            config.heartbeat_retention_days,
            crate::heartbeats::DEFAULT_RETENTION_DAYS
        );
        assert!(config.public_url.is_none());
    }

    #[test]
    fn valid_values_are_used() {
        let config = config(&[
            ("PORT", "8080"),
            ("FLATLINE_HEARTBEAT_RETENTION_DAYS", "0"),
            ("FLATLINE_PUBLIC_URL", " https://uptime.example "),
        ])
        .unwrap();
        assert_eq!(config.port, 8080);
        assert_eq!(config.heartbeat_retention_days, 0);
        assert_eq!(config.public_url.as_deref(), Some("https://uptime.example"));
    }

    #[test]
    fn unparseable_values_fail_with_the_variable_name() {
        for (name, value) in [
            ("PORT", "30o1"),
            ("PORT", "70000"),
            ("PORT", "0"),
            ("FLATLINE_HEARTBEAT_RETENTION_DAYS", "seven"),
            ("FLATLINE_HEARTBEAT_RETENTION_DAYS", "-1"),
        ] {
            let error = config(&[(name, value)]).expect_err(&format!("{name}={value} must fail"));
            let message = error.to_string();
            assert!(message.contains(name), "{message}");
            assert!(message.contains(value), "{message}");
        }
    }
}
