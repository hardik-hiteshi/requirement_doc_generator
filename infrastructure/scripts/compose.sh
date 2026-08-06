#!/usr/bin/env bash
# Wrapper around `docker compose` for the local development stack.
#
# It exists to do three things the raw command cannot:
#
#   1. Load the repository-root .env when present. Compose looks for .env beside
#      the compose file, which is not where this repository keeps it.
#   2. Validate MONGODB_HOST_PORT before starting anything, so a typo surfaces as
#      a clear message instead of a confusing bind failure or, worse, a silent
#      fallback to a port something else already owns.
#   3. Tolerate a missing .env, so `pnpm docker:up` works on a fresh clone.
#
# Usage: infrastructure/scripts/compose.sh <docker compose args...>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infrastructure/docker/docker-compose.yml"

args=(--file "${COMPOSE_FILE}" --project-directory "${REPO_ROOT}")

if [[ -f "${REPO_ROOT}/.env" ]]; then
  args+=(--env-file "${REPO_ROOT}/.env")
fi

# --- Validation -------------------------------------------------------------
# Values already exported in the environment win over .env, matching how compose
# itself resolves variables.
validate_port() {
  local name="$1"
  local value="${2:-}"

  [[ -z "${value}" ]] && return 0

  if ! [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo "Invalid ${name}: '${value}' is not a number." >&2
    exit 1
  fi

  if (( value < 1 || value > 65535 )); then
    echo "Invalid ${name}: ${value} is outside the range 1-65535." >&2
    exit 1
  fi

  if (( value < 1024 )); then
    echo "Invalid ${name}: ${value} is a privileged port; choose 1024 or above." >&2
    exit 1
  fi
}

env_value() {
  local name="$1"

  # Exported value takes precedence.
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
    return 0
  fi

  if [[ -f "${REPO_ROOT}/.env" ]]; then
    # Last assignment wins, matching dotenv semantics. Strips optional quotes.
    sed -n "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*//p" "${REPO_ROOT}/.env" \
      | tail -n 1 \
      | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" \
      | tr -d '\r'
  fi
}

validate_port MONGODB_HOST_PORT "$(env_value MONGODB_HOST_PORT)"
validate_port MONGO_EXPRESS_HOST_PORT "$(env_value MONGO_EXPRESS_HOST_PORT)"
validate_port MINIO_HOST_PORT "$(env_value MINIO_HOST_PORT)"
validate_port MINIO_CONSOLE_HOST_PORT "$(env_value MINIO_CONSOLE_HOST_PORT)"
validate_port CLAMAV_HOST_PORT "$(env_value CLAMAV_HOST_PORT)"

exec docker compose "${args[@]}" "$@"
