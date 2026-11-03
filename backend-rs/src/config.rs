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
    /// Public origin used in provisioning docs and scripts
    /// (`https://uptime.example`). Empty falls back to the request's Host.
    pub public_url: Option<String>,
    /// Directory holding the agent binaries, `VERSION` and `sha256sums`
    /// served under `/agent/*`.
    pub agent_dir: PathBuf,
    /// Directory holding the backup-agent builds (`flatline-backup-<os>-<arch>`),
    /// `VERSION-BACKUP` and `sha256sums-backup`, served to backup agents for
    /// self-update under `/api/backup/v1/release/*`.
    pub backup_agent_dir: PathBuf,
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
    /// Kore ID single sign-on; `None` when `KORE_ID_ISSUER` is unset.
    pub kore_id: Option<KoreIdConfig>,
    /// Email and password sign-in (and first-account setup). Default on.
    /// Turning it off needs Kore ID configured, or nobody could sign in.
    pub local_login: bool,
    /// Signing in with an operator token (wall TV, recovery). Bearer use of
    /// tokens on the API is never affected. Default on.
    pub token_login: bool,
}

/// Kore ID (OpenID Connect) relying-party settings. See docs/sso.md.
#[derive(Debug, Clone)]
pub struct KoreIdConfig {
    /// Base URL of the provider (`KORE_ID_ISSUER`); discovery is read from
    /// `<issuer>/.well-known/openid-configuration`.
    pub issuer: String,
    /// This app's client id at the provider (`KORE_ID_CLIENT_ID`,
    /// default `flatline`; `koremonitor` after the rename).
    pub client_id: String,
    /// Client secret (`KORE_ID_CLIENT_SECRET`); unset means a public client.
    pub client_secret: Option<String>,
    /// Send the secret in the token request body instead of HTTP Basic
    /// (`KORE_ID_CLIENT_AUTH=post`).
    pub client_auth_post: bool,
    /// Where the provider returns the browser (`KORE_ID_REDIRECT_URI`,
    /// default `<FLATLINE_PUBLIC_URL>/api/v1/auth/sso/callback`).
    pub redirect_uri: String,
    /// Where the provider returns the browser after sign-out
    /// (`KORE_ID_POST_LOGOUT_REDIRECT_URI`, default `<origin>/sign-in`).
    pub post_logout_redirect_uri: String,
    /// Whether someone Kore ID admits to this app gets an account on first
    /// sign-in (`KORE_ID_AUTO_PROVISION`, default on). Kore ID decides who
    /// may use the app; off means only accounts already tied to a `sub` and
    /// the allowlists below.
    pub auto_provision: bool,
    /// Optional extra filter: emails (lowercased) that may get an account on
    /// first sign-in. With either list set, only listed identities do.
    pub allowed_emails: Vec<String>,
    /// Optional extra filter: provider `sub` values that may get an account
    /// on first sign-in.
    pub allowed_subs: Vec<String>,
}

fn flag(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    default: bool,
) -> anyhow::Result<bool> {
    match lookup(name).map(|v| v.trim().to_ascii_lowercase()).filter(|v| !v.is_empty()) {
        None => Ok(default),
        Some(v) if ["1", "true", "yes", "on"].contains(&v.as_str()) => Ok(true),
        Some(v) if ["0", "false", "no", "off"].contains(&v.as_str()) => Ok(false),
        Some(v) => Err(anyhow::anyhow!("{name} must be true or false, got {v:?}")),
    }
}

fn list(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> Vec<String> {
    lookup(name)
        .unwrap_or_default()
        .split([',', ' ', '\n', ';'])
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect()
}

impl KoreIdConfig {
    fn from_lookup(
        lookup: &impl Fn(&str) -> Option<String>,
        public_url: Option<&str>,
    ) -> anyhow::Result<Option<Self>> {
        let set = |name: &str| {
            lookup(name)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let Some(issuer) = set("KORE_ID_ISSUER") else {
            return Ok(None);
        };
        let issuer = issuer.trim_end_matches('/').to_string();
        let parsed = reqwest::Url::parse(&issuer)
            .map_err(|e| anyhow::anyhow!("KORE_ID_ISSUER is not a URL ({issuer:?}): {e}"))?;
        let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1" | "[::1]"));
        if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
            anyhow::bail!("KORE_ID_ISSUER must be https (http is allowed only for localhost), got {issuer:?}");
        }
        let redirect_uri = match set("KORE_ID_REDIRECT_URI") {
            Some(uri) => uri,
            None => match public_url {
                Some(base) => format!("{}/api/v1/auth/sso/callback", base.trim_end_matches('/')),
                None => anyhow::bail!(
                    "Kore ID needs KORE_ID_REDIRECT_URI or FLATLINE_PUBLIC_URL to know its callback address"
                ),
            },
        };
        let redirect = reqwest::Url::parse(&redirect_uri)
            .map_err(|e| anyhow::anyhow!("KORE_ID_REDIRECT_URI is not a URL ({redirect_uri:?}): {e}"))?;
        let post_logout_redirect_uri = set("KORE_ID_POST_LOGOUT_REDIRECT_URI")
            .unwrap_or_else(|| format!("{}/sign-in", redirect.origin().ascii_serialization()));
        let client_auth_post = match set("KORE_ID_CLIENT_AUTH").as_deref() {
            None | Some("basic") => false,
            Some("post") => true,
            Some(other) => anyhow::bail!("KORE_ID_CLIENT_AUTH must be basic or post, got {other:?}"),
        };
        Ok(Some(Self {
            issuer,
            client_id: set("KORE_ID_CLIENT_ID").unwrap_or_else(|| "flatline".to_string()),
            client_secret: set("KORE_ID_CLIENT_SECRET"),
            client_auth_post,
            redirect_uri,
            post_logout_redirect_uri,
            auto_provision: flag(lookup, "KORE_ID_AUTO_PROVISION", true)?,
            allowed_emails: list(lookup, "KORE_ID_ALLOWED_EMAILS")
                .into_iter()
                .map(|e| e.to_lowercase())
                .collect(),
            allowed_subs: list(lookup, "KORE_ID_ALLOWED_SUBS"),
        }))
    }
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


        let public_url = set("FLATLINE_PUBLIC_URL");

        let agent_dir = set("FLATLINE_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/app/agent"));

        let backup_agent_dir = set("FLATLINE_BACKUP_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/app/backup-agent"));

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

        let kore_id = KoreIdConfig::from_lookup(&lookup, public_url.as_deref())?;
        let local_login = flag(&lookup, "FLATLINE_LOCAL_LOGIN", true)?;
        let token_login = flag(&lookup, "FLATLINE_TOKEN_LOGIN", true)?;
        if kore_id.is_none() && !local_login {
            anyhow::bail!(
                "FLATLINE_LOCAL_LOGIN=false needs Kore ID (KORE_ID_ISSUER); otherwise nobody could sign in"
            );
        }

        Ok(Self {
            data_dir,
            port,
            host,
            public_url,
            agent_dir,
            backup_agent_dir,
            backup_dir,
            heartbeat_retention_days,
            kore_id,
            local_login,
            token_login,
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
    fn kore_id_is_off_by_default_and_parsed_when_set() {
        let off = config(&[]).unwrap();
        assert!(off.kore_id.is_none() && off.local_login && off.token_login);

        let on = config(&[
            ("KORE_ID_ISSUER", "https://id.kore.example/"),
            ("FLATLINE_PUBLIC_URL", "https://uptime.example/"),
            ("KORE_ID_ALLOWED_EMAILS", "A@x.kz, b@x.kz"),
            ("KORE_ID_ALLOWED_SUBS", "sub-1"),
            ("KORE_ID_CLIENT_AUTH", "post"),
            ("FLATLINE_LOCAL_LOGIN", "false"),
        ])
        .unwrap();
        let kore = on.kore_id.unwrap();
        assert_eq!(kore.issuer, "https://id.kore.example");
        assert_eq!(kore.client_id, "flatline");
        assert_eq!(kore.redirect_uri, "https://uptime.example/api/v1/auth/sso/callback");
        assert_eq!(kore.post_logout_redirect_uri, "https://uptime.example/sign-in");
        assert_eq!(kore.allowed_emails, ["a@x.kz", "b@x.kz"]);
        assert_eq!(kore.allowed_subs, ["sub-1"]);
        assert!(kore.client_auth_post && !on.local_login);
        assert!(kore.auto_provision, "Kore ID decides app access, so provisioning is on by default");
        let off = config(&[
            ("KORE_ID_ISSUER", "https://id.kore.example"),
            ("FLATLINE_PUBLIC_URL", "https://uptime.example"),
            ("KORE_ID_AUTO_PROVISION", "false"),
        ])
        .unwrap();
        assert!(!off.kore_id.unwrap().auto_provision);
    }

    #[test]
    fn kore_id_misconfiguration_is_refused() {
        // Local login off without SSO is a lockout.
        assert!(config(&[("FLATLINE_LOCAL_LOGIN", "false")]).is_err());
        // No callback address.
        assert!(config(&[("KORE_ID_ISSUER", "https://id.kore.example")]).is_err());
        // Plain http to a remote provider.
        assert!(config(&[
            ("KORE_ID_ISSUER", "http://id.kore.example"),
            ("KORE_ID_REDIRECT_URI", "https://a.example/cb"),
        ])
        .is_err());
        assert!(config(&[("FLATLINE_TOKEN_LOGIN", "maybe")]).is_err());
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
