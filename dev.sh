#!/usr/bin/env bash
#
# Start the two Flatline dev servers, detached so they survive the shell that
# launched them.
#
# Servers started in the foreground die whenever the session hosting them
# restarts, which makes them useless for hand-testing. These bind to 0.0.0.0 and
# log to .dev-logs/, so they keep running and can be reached from another
# machine on the LAN.
#
# Usage:
#   ./dev.sh            start (or restart) both
#   ./dev.sh stop       stop both
#   ./dev.sh status     show what is listening
#   ./dev.sh logs       tail both logs
#
# Node >= 26.2.0 is required by the backend.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/.dev-logs"
DATA_DIR="${FLATLINE_DATA_DIR:-$ROOT/.dev-data}"

BACKEND_PORT="${FLATLINE_BACKEND_PORT:-3001}"
DASH_PORT="${FLATLINE_DASHBOARD_PORT:-3003}"

mkdir -p "$LOGS" "$DATA_DIR"

# Node 26 lives under nvm on this machine; prefer it if the caller's PATH is
# still on an older version, since the backend refuses to boot otherwise.
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
    # setsid detaches from this shell's process group; nohup ignores HUP, so the
    # server outlives the terminal that started it.
    ( nohup "$@" >"$LOGS/$name.log" 2>&1 & echo $! >"$LOGS/$name.pid" ) >/dev/null 2>&1
    disown 2>/dev/null || true
}

case "${1:-start}" in
    stop)
        echo "Stopping Flatline dev servers:"
        stop_one "dashboard" "vite --port $DASH_PORT"
        stop_one "backend" "tsx server/server.js"
        sleep 1
        ;;
    status)
        for port in "$BACKEND_PORT" "$DASH_PORT"; do
            printf '%s: %s\n' "$port" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || echo down)"
        done
        exit 0
        ;;
    logs)
        tail -n 40 -f "$LOGS"/*.log
        exit 0
        ;;
esac

echo "Starting Flatline dev servers (logs in .dev-logs/):"

# Hitting an unseeded backend just yields the first-run setup screen, which
# serves this server's HTML to every API call and makes the frontends fail with
# confusing JSON parse errors. Seed instead, so the documented tokens exist and
# there is something to look at.
if [ ! -f "$DATA_DIR/kuma.db" ]; then
    echo "  seeding $DATA_DIR …"
    if ! node --import=tsx "$ROOT/extra/seed-dev-data.ts" "$DATA_DIR" >"$LOGS/seed.log" 2>&1; then
        echo "  seeding failed; see .dev-logs/seed.log"
        tail -n 5 "$LOGS/seed.log"
        exit 1
    fi
fi

# Backend. UPTIME_KUMA_HOST=0.0.0.0 is required: the default binds to localhost,
# which is unreachable from another machine.
(
    cd "$ROOT"
    DATA_DIR="$DATA_DIR" \
    PORT="$BACKEND_PORT" \
    UPTIME_KUMA_HOST=0.0.0.0 \
    UPTIME_KUMA_HIDE_LOG=info_db,info_server \
    start_one "backend" npx tsx server/server.js
)

# Wait for the backend before starting the dashboard: it proxies to it, so the
# first requests would fail on boot otherwise.
for _ in $(seq 1 40); do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$BACKEND_PORT/api/v1"; then
        break
    fi
    sleep 1
done

# Operator dashboard and public status pages in one Vite app. --host is
# required: Vite binds to localhost by default, which is unreachable from
# another machine. VITE_FLATLINE_URL is baked in at start, so it must be an
# address the browser can reach: the LAN IP, which works from this machine and
# every other machine on the network. A hostname does not resolve reliably
# (notably on macOS), and 127.0.0.1 would break LAN browsers, so neither is
# used.
LAN_IP_NOW="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"
(
    cd "$ROOT/apps/dashboard"
    VITE_FLATLINE_URL="http://$LAN_IP_NOW:$BACKEND_PORT" \
    start_one "dashboard" npx vite --host 0.0.0.0 --port "$DASH_PORT"
)

sleep 6

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || echo "this-host")"

echo
echo "  backend     http://$LAN_IP:$BACKEND_PORT"
echo "  dashboard   http://$LAN_IP:$DASH_PORT"
echo "  status page http://$LAN_IP:$DASH_PORT/status/northwind"
echo
echo "  ./dev.sh status   check health"
echo "  ./dev.sh logs     follow logs"
echo "  ./dev.sh stop     stop everything"
echo
