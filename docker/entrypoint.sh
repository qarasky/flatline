#!/bin/sh
# Container entrypoint: run the backend as the unprivileged `flatline` user.
#
# Started as root (the default), it makes sure the data directory belongs to
# `flatline` and then drops privileges with setpriv. Volumes written by the
# older root-running image are root-owned; they are handed over here, once,
# so an upgrade needs no manual chown. Started with `--user`, it just runs
# the command as that user (the operator then owns the volume themselves).
#
# `exec` all the way down: the backend is PID 1 and receives SIGTERM itself
# for its graceful shutdown.
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
RUN_USER=flatline

if [ "$(id -u)" = "0" ]; then
    # The backup store (FLATLINE_BACKUP_DIR, set by compose.backups.yaml) is
    # handed over the same way and kept private to the backend.
    for dir in "$DATA_DIR" ${FLATLINE_BACKUP_DIR:+"$FLATLINE_BACKUP_DIR"}; do
        mkdir -p "$dir"
        # Anything not owned by flatline (a root-owned volume from an older
        # image, a file restored by root) is re-owned; a no-op once migrated.
        if [ -n "$(find "$dir" ! -user "$RUN_USER" -print -quit)" ]; then
            echo "entrypoint: handing $dir to $RUN_USER (files owned by another user found)" >&2
            chown -R "$RUN_USER:$RUN_USER" "$dir"
        fi
    done
    if [ -n "${FLATLINE_BACKUP_DIR:-}" ]; then
        chmod 0700 "$FLATLINE_BACKUP_DIR"
    fi
    exec setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups -- "$@"
fi

exec "$@"
