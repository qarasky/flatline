//! Caddy sends a request to the backend only when its path matches the
//! `@backend` matcher in `docker/Caddyfile`; everything else goes to the web
//! app. A route added here but missing there would answer the web app's 404
//! in production while every test passed, so the router's source and the
//! Caddyfile are checked against each other.

use std::path::{Path, PathBuf};

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Every path registered with `.route("…"` in the backend's sources, test
/// modules excluded.
fn backend_routes() -> Vec<String> {
    let mut files = vec![];
    let mut dirs = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
    }
    let mut routes = vec![];
    for file in files {
        let source = read(&file);
        let live = source.split("#[cfg(test)]").next().unwrap_or_default();
        let mut rest = live;
        while let Some(at) = rest.find(".route(") {
            rest = &rest[at + ".route(".len()..];
            let trimmed = rest.trim_start();
            if let Some(quoted) = trimmed.strip_prefix('"') {
                let end = quoted.find('"').expect("closing quote");
                routes.push(quoted[..end].to_string());
            }
        }
    }
    routes.sort();
    routes.dedup();
    routes
}

/// The `@backend path …` matcher's patterns.
fn caddy_backend_paths() -> Vec<String> {
    let caddyfile = read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docker/Caddyfile"));
    let line = caddyfile
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("@backend path "))
        .expect("docker/Caddyfile has an `@backend path …` matcher");
    line["@backend path ".len()..]
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// Caddy's `path` matcher: a trailing `*` is a prefix, anything else exact.
fn matches(pattern: &str, path: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => path.starts_with(prefix),
        None => pattern == path,
    }
}

#[test]
fn every_backend_route_reaches_the_backend() {
    let routes = backend_routes();
    assert!(
        routes.len() > 40,
        "found only {} routes: the parser is broken",
        routes.len()
    );
    let patterns = caddy_backend_paths();
    let missed: Vec<&String> = routes
        .iter()
        .filter(|route| !patterns.iter().any(|pattern| matches(pattern, route)))
        .collect();
    assert!(
        missed.is_empty(),
        "Caddy would send these to the web app: {missed:?}"
    );
}

#[test]
fn the_web_app_keeps_its_own_paths() {
    // The backend matcher must not swallow the web app's pages.
    let patterns = caddy_backend_paths();
    for page in [
        "/",
        "/monitors",
        "/sign-in",
        "/status/acme",
        "/superboard/kiosk",
        "/build",
        "/index.html",
        "/_next/static/x.js",
        "/icon.svg",
    ] {
        assert!(
            !patterns.iter().any(|pattern| matches(pattern, page)),
            "{page} would go to the backend"
        );
    }
}
