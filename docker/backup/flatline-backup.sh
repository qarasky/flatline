#!/usr/bin/env bash
# Nightly backup of Flatline's own database (see docs/operations.md#backups;
# client application data is the backup agent's job, docs/backup-agent.md).
#
# 1. Copies the live SQLite database through the SQLite backup API over a
#    read-only connection, so the running container keeps writing (WAL
#    readers never block the writer) and the copy is consistent.
# 2. Refuses the copy unless `PRAGMA integrity_check` says `ok`.
# 3. Keeps KEEP_DAILY daily and KEEP_WEEKLY weekly copies (gzip'd).
# 4. Optionally mirrors the backup directory off-host with rsync or rclone.
#
# Configuration comes from the environment (the systemd unit loads
# /etc/flatline-backup.env); every value has a default for the office host.
# Needs python3 (its sqlite3 module) and gzip; rsync/rclone only when an
# off-host target is set.
set -euo pipefail

FLATLINE_DB="${FLATLINE_DB:-/home/office/flatline/data-rust/flatline.db}"
BACKUP_DIR="${BACKUP_DIR:-/home/office/flatline/backups/nightly}"
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
# ISO day of week (1 = Monday … 7 = Sunday) whose backup is also kept as a weekly.
WEEKLY_DAY="${WEEKLY_DAY:-7}"
# Off-host copy: empty skips it. rsync: "user@host:/path"; rclone: "remote:path".
OFFSITE_TARGET="${OFFSITE_TARGET:-}"
OFFSITE_TOOL="${OFFSITE_TOOL:-rsync}"
# Optional URL fetched after a successful run (dead-man's switch, e.g. a
# healthchecks.io check or a Flatline push URL on another instance).
NOTIFY_URL="${NOTIFY_URL:-}"

log() { printf 'flatline-backup: %s\n' "$*" >&2; }
die() {
    log "FAILED: $*"
    exit 1
}

for value in "$KEEP_DAILY" "$KEEP_WEEKLY" "$WEEKLY_DAY"; do
    [[ "$value" =~ ^[0-9]+$ ]] || die "KEEP_DAILY, KEEP_WEEKLY and WEEKLY_DAY must be integers"
done
[[ -f "$FLATLINE_DB" ]] || die "database not found: $FLATLINE_DB"
command -v python3 >/dev/null || die "python3 is required"
command -v gzip >/dev/null || die "gzip is required"

umask 077
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

stamp="$(date -u +%Y%m%d-%H%M%S)"
partial="$BACKUP_DIR/.flatline-$stamp.db.partial"
trap 'rm -f "$partial" "$partial.gz"' EXIT

# Backup API in steps of 1024 pages with a short pause between them, so a
# large database never starves the backend; a step that hits a lock is
# retried by sqlite3 itself (timeout = busy wait). The copy is checked
# before anything is kept.
python3 - "$FLATLINE_DB" "$partial" <<'PY'
import sqlite3, sys
source, target = sys.argv[1], sys.argv[2]
live = sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=30)
copy = sqlite3.connect(target)
try:
    live.backup(copy, pages=1024, sleep=0.05)
    result = copy.execute("PRAGMA integrity_check").fetchone()[0]
finally:
    copy.close()
    live.close()
if result != "ok":
    sys.exit(f"integrity_check on the copy returned: {result}")
PY

gzip -9 "$partial"
daily="$BACKUP_DIR/daily/flatline-$stamp.db.gz"
mv "$partial.gz" "$daily"
log "wrote $daily ($(du -h "$daily" | cut -f1))"

# One weekly per WEEKLY_DAY: a manual run on that day does not add a second.
if [[ "$(date -u +%u)" == "$WEEKLY_DAY" ]] &&
    [[ -z "$(find "$BACKUP_DIR/weekly" -maxdepth 1 -name "flatline-${stamp%%-*}-*.db.gz" -print -quit)" ]]; then
    weekly="$BACKUP_DIR/weekly/flatline-$stamp.db.gz"
    ln "$daily" "$weekly" 2>/dev/null || cp "$daily" "$weekly"
    log "kept $weekly as this week's copy"
fi

# Rotation: names sort chronologically, so keep the newest N of each.
rotate() {
    local dir="$1" keep="$2"
    local files=()
    mapfile -t files < <(find "$dir" -maxdepth 1 -type f -name 'flatline-*.db.gz' | sort -r)
    local i
    for ((i = keep; i < ${#files[@]}; i++)); do
        rm -f -- "${files[$i]}"
        log "rotated out ${files[$i]}"
    done
}
rotate "$BACKUP_DIR/daily" "$KEEP_DAILY"
rotate "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"

if [[ -n "$OFFSITE_TARGET" ]]; then
    case "$OFFSITE_TOOL" in
        rsync)
            command -v rsync >/dev/null || die "rsync is required for OFFSITE_TOOL=rsync"
            rsync -aH --delete "$BACKUP_DIR/" "$OFFSITE_TARGET/"
            ;;
        rclone)
            command -v rclone >/dev/null || die "rclone is required for OFFSITE_TOOL=rclone"
            rclone sync "$BACKUP_DIR" "$OFFSITE_TARGET"
            ;;
        *) die "OFFSITE_TOOL must be rsync or rclone, not '$OFFSITE_TOOL'" ;;
    esac
    log "mirrored $BACKUP_DIR to $OFFSITE_TARGET ($OFFSITE_TOOL)"
else
    log "OFFSITE_TARGET not set; off-host copy skipped"
fi

if [[ -n "$NOTIFY_URL" ]]; then
    curl -fsS -m 10 --retry 3 -o /dev/null "$NOTIFY_URL" || log "warning: NOTIFY_URL did not answer"
fi

log "done"
