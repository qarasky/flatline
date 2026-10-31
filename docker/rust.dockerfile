############################################
# Rust backend image: the API, the check engine and the agent downloads.
# The web app is its own image (docker/web.dockerfile) behind Caddy
# (docker/caddy.dockerfile); see compose.yaml.
#
# Build from the repository root (linux/amd64 for the office server):
#   docker build --platform linux/amd64 -f docker/rust.dockerfile \
#       -t artchsh/flatline-rust:office-live .
#
# The database is created and migrated on first start; to bring an older
# database across, `flatline-backend import`. See docs/deployment.md.
############################################

# Agent build: the Go binary served under /agent/* for installs and updates.
# Static (CGO off) so it runs on any glibc/musl host. VERSION is what
# `superboard version` prints; sha256sums is what install.sh verifies.
FROM golang:1.27-trixie AS agent
WORKDIR /src

COPY superboard/go.mod superboard/go.sum ./
RUN go mod download

COPY superboard ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" \
        -o /out/superboard-linux-amd64 . \
    && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" \
        -o /out/superboard-linux-arm64 . \
    && /out/superboard-linux-amd64 version | cut -d' ' -f2 > /out/VERSION \
    && cd /out && sha256sum superboard-linux-amd64 superboard-linux-arm64 > sha256sums

# Backup agent build: a separate Go module and binary family. These live
# under /app/backup-agent and never replace the telemetry agent's VERSION or
# sha256sums.
FROM golang:1.27-trixie AS backup-agent
WORKDIR /src

COPY backup-agent/go.mod backup-agent/go.sum ./
RUN go mod download

COPY backup-agent ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" \
        -o /out/flatline-backup-linux-amd64 . \
    && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" \
        -o /out/flatline-backup-linux-arm64 . \
    && /out/flatline-backup-linux-amd64 version | cut -d' ' -f2 > /out/VERSION-BACKUP \
    && cd /out && sha256sum flatline-backup-linux-amd64 flatline-backup-linux-arm64 > sha256sums-backup

# Rust build. Dependencies are cached against a dummy crate so source edits
# do not rebuild the world.
FROM rust:1.99-trixie AS build
WORKDIR /app

COPY backend-rs/Cargo.toml backend-rs/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && echo "" > src/lib.rs \
    && cargo build --release \
    && rm -rf src

COPY backend-rs/src src
COPY backend-rs/migrations migrations
# Embedded with include_str! by src/api/provisioning.rs and src/api/openapi.rs.
# The paths resolve from /app/src/api to the container root, not /app, so the
# images of these files land at /docs/provisioning.md and /agent-install.sh.
COPY docs/provisioning.md /docs/provisioning.md
COPY agent-install.sh /agent-install.sh
RUN touch src/main.rs src/lib.rs && cargo build --release

# Runtime: glibc base matching the build image, curl for the healthcheck,
# iputils-ping for the ICMP checker.
FROM debian:trixie-slim AS release

# The backend runs as `flatline` (uid/gid 10001), not root. ICMP checks shell
# out to iputils ping, which needs either CAP_NET_RAW or an unprivileged ICMP
# socket allowed by net.ipv4.ping_group_range. Both are provided: the binary
# gets the file capability here (Docker's default capability set includes
# NET_RAW), and the compose files set ping_group_range for the container.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl iputils-ping libcap2-bin \
    && ping_bin="$(readlink -f "$(command -v ping)")" \
    && chmod u-s "$ping_bin" \
    && setcap cap_net_raw+p "$ping_bin" \
    && apt-get purge --yes --auto-remove libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 flatline \
    && useradd --system --uid 10001 --gid flatline --home-dir /app/data --no-create-home \
        --shell /usr/sbin/nologin flatline

WORKDIR /app

ENV UPTIME_KUMA_IS_CONTAINER=1 \
    DATA_DIR=/app/data \
    PORT=3001 \
    FLATLINE_AGENT_DIR=/app/agent \
    FLATLINE_BACKUP_AGENT_DIR=/app/backup-agent

COPY --from=build /app/target/release/flatline-backend /usr/local/bin/flatline-backend
COPY --from=agent /out /app/agent
COPY docker/entrypoint.sh /usr/local/bin/flatline-entrypoint
COPY --from=backup-agent /out /app/backup-agent

RUN mkdir -p /app/data && chown flatline:flatline /app/data

EXPOSE 3001
# /healthz answers 200 only when the database and the check engine are
# healthy (503 otherwise), without a token. Docker itself never restarts an
# unhealthy container; see docs/operations.md for the external watcher.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -fsS --max-time 8 http://127.0.0.1:3001/healthz >/dev/null || exit 1

# The entrypoint hands /app/data to `flatline` (once, for volumes written by
# the old root image) and drops privileges with setpriv; it execs, so the
# backend is PID 1 and handles SIGTERM itself (graceful shutdown).
ENTRYPOINT ["flatline-entrypoint"]
CMD ["flatline-backend"]
