#!/usr/bin/env bash
# Blocks until MongoDB accepts connections, or fails after a timeout.
#
# Used before the integration suite, locally and in CI. A fixed `sleep` is the
# usual alternative and is wrong in both directions: too short on a slow runner,
# wasted time on a fast one.
#
# Port resolution order: MONGO_PORT (explicit override) -> MONGODB_HOST_PORT
# (the compose host port) -> 27017.
set -euo pipefail

HOST="${MONGO_HOST:-127.0.0.1}"
PORT="${MONGO_PORT:-${MONGODB_HOST_PORT:-27017}}"
TIMEOUT_SECONDS="${MONGO_WAIT_TIMEOUT:-60}"

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid MongoDB port: '${PORT}'" >&2
  exit 2
fi

echo "Waiting for MongoDB at ${HOST}:${PORT} (timeout ${TIMEOUT_SECONDS}s)..."

deadline=$(( SECONDS + TIMEOUT_SECONDS ))

while (( SECONDS < deadline )); do
  if (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null; then
    exec 3>&- 3<&-
    echo "MongoDB is accepting connections on ${HOST}:${PORT}."
    exit 0
  fi
  sleep 1
done

echo "Timed out after ${TIMEOUT_SECONDS}s waiting for MongoDB at ${HOST}:${PORT}" >&2
exit 1
