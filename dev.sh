#!/usr/bin/env bash
#
# Start the Flatline dev servers, detached so they survive the shell that
# launched them.
#
# The backend is the Rust service in backend-rs/. The operator dashboard is the
# Vite app in apps/dashboard: Vite proxies /api and /agent to the backend
# (see apps/dashboard/vite.config.ts), so the app is same-origin in dev exactly
# as it is in production.
#
# Mock data: the Go mock agent (superboard/mockagent) creates a demo fleet
# through the public API and pushes telemetry for it, so the Superboard shows
# every card state without any real hosts.
#
# Servers started in the foreground die whenever the session hosting them
# restarts, which makes them useless for hand-testing. These bind to 0.0.0.0 and
# log to .dev-logs/, so they keep running and can be reached from another
# machine on the LAN.
#
# Usage:
#   ./dev.sh            start (or restart) everything
#   ./dev.sh stop       stop everything
#   ./dev.sh status     show what is listening
#   ./dev.sh logs       tail all logs
#
# Requires: cargo (Rust backend), go (agent + mock agent), node (Vite only).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/.dev-logs"
DATA_DIR="${FLATLINE_DATA_DIR:-$ROOT/.dev-data}"
AGENT_DIR="$DATA_DIR/agent"

BACKEND_PORT="${FLATLINE_BACKEND_PORT:-3001}"
DASH_PORT="${FLATLINE_DASHBOARD_PORT:-3003}"

mkdir -p "$LOGS" "$DATA_DIR" "$AGENT_DIR"

# Node is only needed for Vite here. Prefer a modern Node from nvm if the
# caller's PATH is still on an older one.
if [ -d "$HOME/.nvm/versions/node" ]; then
    NEWEST="$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -1)"
    if [ -n "$NEWEST" ]; then
        export PATH="$HOME/.nvm/versions/node/$NEWEST/bin:$PATH"
    fi
fi

stop_one() {
    local name="$1"
    local pattern="$2"
    if pkill -f "$pattern" 2>/dev/null; then
        echo "  stopped $name"
    fi
}

start_one() {
    local name="$1"
    shift
    # nohup ignores HUP so the server outlives the terminal that started it.
    ( nohup "$@" >"$LOGS/$name.log" 2>&1 & echo $! >"$LOGS/$name.pid" ) >/dev/null 2>&1
    disown 2>/dev/null || true
}

case "${1:-start}" in
    stop)
        echo "Stopping Flatline dev servers:"
        stop_one "dashboard" "vite.*--port $DASH_PORT"
        stop_one "backend" "flatline-backend"
        stop_one "mock-agent" "mockagent"
        sleep 1
        exit 0
        ;;
    status)
        printf '%s: %s\n' "backend" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$BACKEND_PORT/api/v1/auth/setup" 2>/dev/null || echo down)"
        printf '%s: %s\n' "dashboard" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DASH_PORT/" 2>/dev/null || echo down)"
        exit 0
        ;;
    logs)
        tail -n 40 -f "$LOGS"/*.log
        exit 0
        ;;
esac

echo "Starting Flatline dev servers (logs in .dev-logs/):"

# --- build -----------------------------------------------------------------

if ! command -v cargo >/dev/null 2>&1; then
    echo "  cargo not found: the Rust backend is required" >&2
    exit 1
fi

echo "  building backend …"
if ! cargo build --quiet --manifest-path "$ROOT/backend-rs/Cargo.toml" >"$LOGS/backend-build.log" 2>&1; then
    echo "  backend build failed; see .dev-logs/backend-build.log"
    tail -n 10 "$LOGS/backend-build.log"
    exit 1
fi
BACKEND_BIN="$ROOT/backend-rs/target/debug/flatline-backend"

# The agent binaries the download endpoints serve, plus the mock agent.
if command -v go >/dev/null 2>&1; then
    AGENT_GOOS="$(go env GOOS)"
    AGENT_GOARCH="$(go env GOARCH)"
    if ( cd "$ROOT/superboard" && CGO_ENABLED=0 go build -trimpath -o "$AGENT_DIR/superboard-$AGENT_GOOS-$AGENT_GOARCH" . ) >"$LOGS/agent-build.log" 2>&1; then
        "$AGENT_DIR/superboard-$AGENT_GOOS-$AGENT_GOARCH" version | awk '{print $2}' >"$AGENT_DIR/VERSION"
        echo "  built agent superboard-$AGENT_GOOS-$AGENT_GOARCH $(cat "$AGENT_DIR/VERSION")"
    else
        echo "  agent build failed; see .dev-logs/agent-build.log"
    fi
    if ( cd "$ROOT/superboard" && go build -o "$DATA_DIR/mockagent" ./mockagent ) >"$LOGS/mockagent-build.log" 2>&1; then
        echo "  built mock agent"
    else
        echo "  mock agent build failed; see .dev-logs/mockagent-build.log"
    fi
else
    echo "  go not found: skipping the agent and mock-data builds"
fi

# --- backend ---------------------------------------------------------------

(
    cd "$ROOT"
    DATA_DIR="$DATA_DIR" \
    PORT="$BACKEND_PORT" \
    UPTIME_KUMA_HOST=0.0.0.0 \
    FLATLINE_AGENT_DIR="$AGENT_DIR" \
    start_one "backend" "$BACKEND_BIN"
)

# Wait for the backend: it runs migrations and writes the operator token on
# first boot, and everything below depends on both.
for _ in $(seq 1 40); do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$BACKEND_PORT/api/v1/auth/setup"; then
        break
    fi
    sleep 1
done

# The operator token is this instance's sign-in credential (mode 0600).
TOKEN=""
if [ -f "$DATA_DIR/initial-token.txt" ]; then
    TOKEN="$(tr -d '\r\n' <"$DATA_DIR/initial-token.txt")"
fi

# --- mock fleet ------------------------------------------------------------

if [ -x "$DATA_DIR/mockagent" ]; then
    if [ -n "$TOKEN" ]; then
        start_one "mock-agent" "$DATA_DIR/mockagent" \
            --server "http://127.0.0.1:$BACKEND_PORT" --token "$TOKEN" --interval 3s
    else
        echo "  no operator token found; skipping the mock fleet"
    fi
fi

# --- dashboard -------------------------------------------------------------

# Same-origin in dev: Vite proxies /api and /agent to the backend (see
# vite.config.ts), so the app talks to its own origin exactly as it does in
# production. No CORS, no origin baked into the bundle.
(
    cd "$ROOT/apps/dashboard"
    FLATLINE_DEV_BACKEND="http://127.0.0.1:$BACKEND_PORT" \
    start_one "dashboard" npx vite --host 0.0.0.0 --port "$DASH_PORT"
)

sleep 6

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || echo "this-host")"

echo
echo "  backend     http://$LAN_IP:$BACKEND_PORT"
echo "  dashboard   http://$LAN_IP:$DASH_PORT"
echo "  superboard  http://$LAN_IP:$DASH_PORT/superboard   (kiosk: /superboard/kiosk, scope: /superboard/kiosk/work)"
echo
if [ -n "$TOKEN" ]; then
    echo "  operator token: $TOKEN"
else
    echo "  operator token: see $DATA_DIR/initial-token.txt"
fi
echo
echo "  ./dev.sh status   check health"
echo "  ./dev.sh logs     follow logs"
echo "  ./dev.sh stop     stop everything"
echo
