#!/usr/bin/env bash
# Flatline Superboard agent installer / updater.
#
# Served by the Flatline server with the download credential already
# substituted, so a host needs exactly one command:
#
#   curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- \
#       --server <origin> --token <PUSH_TOKEN>     # fresh install
#   curl -fsSL '<origin>/agent/install.sh?token=<key>' | sudo bash -s -- --update
#
# Fresh install: downloads the agent, verifies its sha256, then
# `superboard install` writes /etc/superboard/config.json (0600) and the
# systemd unit and starts the service.
# Update: keeps the config and push token, replaces the binary (a copy of
# the previous one stays at /usr/local/bin/superboard.bak) and restarts.
set -euo pipefail

ORIGIN="{{ORIGIN}}"
DOWNLOAD_TOKEN="{{TOKEN}}"

SERVER=""
PUSH_TOKEN=""
INTERVAL=""
UPDATE=0

usage() {
    cat <<'EOF'
usage: install.sh [--server URL] [--token PUSH_TOKEN] [--interval SECONDS] [--update]

  --server URL        Flatline origin, used for the agent config and for the
                      downloads (default: the origin this script came from)
  --token PUSH_TOKEN  the monitor's push token; required for a fresh install
  --interval SECONDS  live sample interval (default 1)
  --update            update an existing install: replace the binary and
                      restart; config and push token are kept
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --server) SERVER="$2"; shift 2 ;;
        --token) PUSH_TOKEN="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --update) UPDATE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "install.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "install.sh: must run as root (pipe it into: sudo bash -s -- ...)" >&2
    exit 1
fi

if [ -z "$SERVER" ]; then
    SERVER="$ORIGIN"
fi

case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "install.sh: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

FILE="superboard-linux-$ARCH"
CONFIG="/etc/superboard/config.json"
BIN="/usr/local/bin/superboard"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "install.sh: downloading $FILE from $SERVER"
curl -fsSL --retry 3 "$SERVER/agent/$FILE?token=$DOWNLOAD_TOKEN" -o "$tmp/$FILE"
curl -fsSL --retry 3 "$SERVER/agent/sha256sums?token=$DOWNLOAD_TOKEN" -o "$tmp/sha256sums"

echo "install.sh: verifying sha256"
( cd "$tmp" && grep -E "  $FILE\$" sha256sums | sha256sum -c - ) \
    || { echo "install.sh: checksum verification failed" >&2; exit 1; }

chmod 0755 "$tmp/$FILE"

if [ -f "$CONFIG" ] || [ "$UPDATE" -eq 1 ]; then
    if [ ! -f "$CONFIG" ]; then
        echo "install.sh: --update given but $CONFIG does not exist; run a fresh install" >&2
        exit 1
    fi
    echo "install.sh: updating existing install (config and push token kept)"
    if command -v systemctl >/dev/null 2>&1; then
        # Sync systemd with whatever unit is on disk before touching the
        # service, so a unit edited outside install cannot warn/stale here.
        systemctl daemon-reload 2>/dev/null || true
        systemctl stop superboard 2>/dev/null || true
    fi
    if [ -f "$BIN" ]; then
        cp -a "$BIN" "$BIN.bak"
    fi
    mv "$tmp/$FILE" "$BIN"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl start superboard
    else
        echo "install.sh: no systemd; start the agent manually (cron @reboot handles reboots)" >&2
    fi
else
    if [ -z "$PUSH_TOKEN" ]; then
        echo "install.sh: a fresh install needs --token <push token>" >&2
        exit 2
    fi
    if [ -f "$BIN" ]; then
        cp -a "$BIN" "$BIN.bak"
    fi
    mv "$tmp/$FILE" "$BIN"
    if [ -n "$INTERVAL" ]; then
        "$BIN" install --server "$SERVER" --token "$PUSH_TOKEN" --interval "$INTERVAL"
    else
        "$BIN" install --server "$SERVER" --token "$PUSH_TOKEN"
    fi
fi

sleep 1
if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active superboard || true
fi
"$BIN" version
