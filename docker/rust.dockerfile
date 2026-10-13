############################################
# Rust backend image: the API, the check engine and the web app in one
# binary plus one directory of static assets.
#
# Build from the repository root (linux/amd64 for the office server):
#   docker build --platform linux/amd64 -f docker/rust.dockerfile \
#       -t artchsh/flatline-rust:office-live .
#
# Stage a copy of the production database with the importer first; see
# docker/RUST-CUTOVER.md.
############################################

# Web app build (dashboard + status pages, one Vite app).
FROM node:26-trixie-slim AS web
WORKDIR /app

COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/dashboard/package-lock.json apps/dashboard/package-lock.json
COPY apps/dashboard/index.html apps/dashboard/index.html
COPY apps/dashboard/vite.config.ts apps/dashboard/vite.config.ts
COPY apps/dashboard/tsconfig.json apps/dashboard/tsconfig.json
COPY apps/dashboard/src apps/dashboard/src
COPY apps/dashboard/public apps/dashboard/public

WORKDIR /app/apps/dashboard
RUN npm ci --no-audit --no-fund
RUN npm run build

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
# Embedded with include_str! by src/api/provisioning.rs; the paths resolve
# to the container root, not /app.
COPY add-push-server.md /add-push-server.md
COPY agent-install.sh /agent-install.sh
RUN touch src/main.rs src/lib.rs && cargo build --release

# Runtime: glibc base matching the build image, curl for the healthcheck,
# iputils-ping for the ICMP checker.
FROM debian:trixie-slim AS release

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV UPTIME_KUMA_IS_CONTAINER=1 \
    DATA_DIR=/app/data \
    PORT=3001 \
    FLATLINE_WEB_DIST=/app/dashboard \
    FLATLINE_AGENT_DIR=/app/agent

COPY --from=build /app/target/release/flatline-backend /usr/local/bin/flatline-backend
COPY --from=web /app/apps/dashboard/dist /app/dashboard
COPY --from=agent /out /app/agent

RUN mkdir -p /app/data

EXPOSE 3001
# The public setup endpoint answers without a token; any 200 means the
# server is up. Startup is immediate, unlike the Node image's 180s grace.
HEALTHCHECK --interval=60s --timeout=30s --start-period=15s --retries=5 \
    CMD curl -fsS http://127.0.0.1:3001/api/v1/auth/setup >/dev/null || exit 1

# The binary handles SIGTERM itself (graceful shutdown), so no init shim.
CMD ["flatline-backend"]
