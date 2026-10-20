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
    mkdir -p "$DATA_DIR"
    # Anything not owned by flatline (a root-owned volume from an older
    # image, a file restored by root) is re-owned; a no-op once migrated.
    if [ -n "$(find "$DATA_DIR" ! -user "$RUN_USER" -print -quit)" ]; then
        echo "entrypoint: handing $DATA_DIR to $RUN_USER (files owned by another user found)" >&2
        chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"
    fi
    exec setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups -- "$@"
fi

exec "$@"
