#!/usr/bin/env bash
# Blocks until every Phase 3 service accepts connections, or fails with a
# message naming the one that did not.
#
# A fixed `sleep` is the usual alternative and is wrong in both directions: too
# short on a loaded runner, wasted minutes on a fast one. ClamAV in particular
# takes a genuinely long time on a cold start — it loads roughly a gigabyte of
# signatures before it will answer — so it gets its own, longer budget.
#
# Each service can be skipped, because not every task needs all three: the unit
# suite needs none, the API integration suite needs MongoDB, and only the
# storage and scanner suites need MinIO and ClamAV.
set -euo pipefail

HOST="${SERVICES_HOST:-127.0.0.1}"

wait_for() {
  local label="$1" port="$2" timeout="$3"

  if [[ -z "${port}" || "${port}" == "skip" ]]; then
    echo "Skipping ${label}."
    return 0
  fi

  if ! [[ "${port}" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "Invalid ${label} port: '${port}'" >&2
    return 2
  fi

  echo "Waiting for ${label} at ${HOST}:${port} (timeout ${timeout}s)..."
  local deadline=$(( SECONDS + timeout ))

  while (( SECONDS < deadline )); do
    if (exec 3<>"/dev/tcp/${HOST}/${port}") 2>/dev/null; then
      exec 3>&- 3<&-
      echo "  ${label} is accepting connections."
      return 0
    fi
    sleep 1
  done

  echo "Timed out after ${timeout}s waiting for ${label} at ${HOST}:${port}" >&2
  return 1
}

wait_for "MongoDB" "${MONGODB_HOST_PORT:-27017}" "${MONGO_WAIT_TIMEOUT:-60}"
wait_for "MinIO"   "${MINIO_HOST_PORT:-9000}"    "${MINIO_WAIT_TIMEOUT:-60}"
# Longer by default: the daemon does not open its port until the signature
# database is in memory.
wait_for "ClamAV"  "${CLAMAV_HOST_PORT:-3310}"   "${CLAMAV_WAIT_TIMEOUT:-300}"

echo "Every requested service is ready."
