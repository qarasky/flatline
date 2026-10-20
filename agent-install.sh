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
# the previous one stays at /usr/local/bin/superboard.bak), refreshes the
# systemd unit, restarts, and rolls back to .bak unless the new agent stays
# up (same PID, no restarts) for the health window.
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
MARKER="/var/lib/superboard/update/first-push-ok"

# A running systemd, not just its binary: containers often ship systemctl
# without systemd as PID 1, and then every systemctl call fails.
HAS_SYSTEMD=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    HAS_SYSTEMD=1
fi

# Bounded downloads: a stalled connection must fail, not hang the shell
# (or the provisioning run) forever.
CURL=(curl -fsSL --connect-timeout 10 --max-time 300 --retry 3 --retry-delay 2)

# How long an updated agent must stay up (same PID, no restarts).
HEALTH_WINDOW=30

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "install.sh: downloading $FILE from $SERVER"
"${CURL[@]}" "$SERVER/agent/$FILE?token=$DOWNLOAD_TOKEN" -o "$tmp/$FILE"
"${CURL[@]}" "$SERVER/agent/sha256sums?token=$DOWNLOAD_TOKEN" -o "$tmp/sha256sums"

echo "install.sh: verifying sha256"
( cd "$tmp" && grep -E "  $FILE\$" sha256sums | sha256sum -c - ) \
    || { echo "install.sh: checksum verification failed" >&2; exit 1; }

chmod 0755 "$tmp/$FILE"

# put_file SRC DST: copy next to DST, then rename over it. DST is always
# either the old file or the complete new one, and a running binary is
# replaced (new inode) instead of written into (ETXTBSY / torn binary).
put_file() {
    install -m 0755 "$1" "$2.new"
    mv -f "$2.new" "$2"
}

service_prop() {
    printf '%s\n' "$1" | sed -n "s/^$2=//p"
}

# wait_healthy: the service must reach active with a main PID within 30s,
# then keep that MainPID and NRestarts for HEALTH_WINDOW seconds. "active"
# alone is true the moment the process exists; a build that crashes and is
# restarted by Restart=always shows up as a PID or NRestarts change.
HEALTHY_PID=""
wait_healthy() {
    local deadline=$((SECONDS + 30)) base_pid="" base_restarts="" st state pid restarts
    while :; do
        st="$(systemctl show superboard --property=ActiveState,MainPID,NRestarts 2>/dev/null || true)"
        state="$(service_prop "$st" ActiveState)"
        pid="$(service_prop "$st" MainPID)"
        restarts="$(service_prop "$st" NRestarts)"
        if [ -z "$base_pid" ]; then
            if [ "$state" = "active" ] && [ "${pid:-0}" != "0" ]; then
                base_pid="$pid"
                base_restarts="$restarts"
                deadline=$((SECONDS + HEALTH_WINDOW))
            elif [ "$SECONDS" -ge "$deadline" ]; then
                echo "install.sh: superboard did not become active within 30s" >&2
                return 1
            fi
        else
            if [ "$state" != "active" ] || [ "$pid" != "$base_pid" ] || [ "$restarts" != "$base_restarts" ]; then
                echo "install.sh: superboard restarted or stopped during the health window (pid $base_pid -> ${pid:-none}, state ${state:-unknown})" >&2
                return 1
            fi
            if [ "$SECONDS" -ge "$deadline" ]; then
                HEALTHY_PID="$base_pid"
                return 0
            fi
        fi
        sleep 2
    done
}

if [ -f "$CONFIG" ] || [ "$UPDATE" -eq 1 ]; then
    if [ ! -f "$CONFIG" ]; then
        echo "install.sh: --update given but $CONFIG does not exist; run a fresh install" >&2
        exit 1
    fi
    echo "install.sh: updating existing install (config and push token kept)"
    if [ -f "$BIN" ]; then
        put_file "$BIN" "$BIN.bak"
    fi
    put_file "$tmp/$FILE" "$BIN"
    if [ "$HAS_SYSTEMD" -eq 1 ]; then
        # Bring the unit written by an older release up to the current
        # template (keeps its ExecStart) and reload systemd.
        "$BIN" refresh-unit || echo "install.sh: warning: could not refresh the unit file" >&2
        systemctl daemon-reload
        rm -f "$MARKER"
        systemctl restart superboard
        echo "install.sh: waiting ${HEALTH_WINDOW}s for the new agent to stay up"
        if ! wait_healthy; then
            if [ -f "$BIN.bak" ]; then
                echo "install.sh: rolling back to the previous build" >&2
                put_file "$BIN.bak" "$BIN"
                systemctl restart superboard || true
            fi
            exit 1
        fi
        # Informational: a push the server accepted. Absent can mean the
        # server is down, not the agent; the journal says which.
        if [ -f "$MARKER" ] && [ "$(awk '{print $2}' "$MARKER")" = "$HEALTHY_PID" ]; then
            echo "install.sh: new agent is up and its first push was accepted"
        else
            echo "install.sh: new agent is up, but no push was accepted yet — check 'journalctl -u superboard'" >&2
        fi
    else
        echo "install.sh: no running systemd; restart the agent manually (cron @reboot handles reboots)" >&2
    fi
else
    if [ -z "$PUSH_TOKEN" ]; then
        echo "install.sh: a fresh install needs --token <push token>" >&2
        exit 2
    fi
    if [ -f "$BIN" ]; then
        put_file "$BIN" "$BIN.bak"
    fi
    put_file "$tmp/$FILE" "$BIN"
    if [ -n "$INTERVAL" ]; then
        "$BIN" install --server "$SERVER" --token "$PUSH_TOKEN" --interval "$INTERVAL"
    else
        "$BIN" install --server "$SERVER" --token "$PUSH_TOKEN"
    fi
    sleep 1
    if [ "$HAS_SYSTEMD" -eq 1 ]; then
        systemctl is-active superboard || true
    fi
fi

"$BIN" version
