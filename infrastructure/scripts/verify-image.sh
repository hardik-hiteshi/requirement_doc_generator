#!/usr/bin/env bash
# Inspects a built image for the things that must and must not be in it.
#
# A Dockerfile states an intention. This checks the artefact, because the two come apart
# in ways that are invisible in review: a `COPY` that pulled in more than it named, a
# `.dockerignore` entry that stopped matching when a file moved, a base image that
# started shipping something new. Each check below is a claim made in
# docs/operations/deployment.md, verified against the image rather than asserted.
#
# The ones that matter most:
#
#   **No `.env`, no keys, no `.git`.** These are the ways a credential reaches a
#   registry. `.dockerignore` denies everything by default specifically so that a new
#   secret-bearing file is absent until a COPY names it — and this is what proves the
#   deny-list held.
#
#   **No TypeScript sources.** The image ships compiled output. Source in a runtime
#   image means the build stage leaked into the shipped layer, which is both larger than
#   it should be and a signal that the multi-stage separation is not doing its job.
#
#   **Not root, and no package manager.** A production container that can install
#   software is a production container that can be made to run something new.
#
# Usage: infrastructure/scripts/verify-image.sh <image> [--api|--web]
set -uo pipefail

IMAGE="${1:-}"
KIND=''

[[ -n "${IMAGE}" ]] || { echo 'Usage: verify-image.sh <image> [--api|--web]' >&2; exit 2; }
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) KIND='api'; shift ;;
    --web) KIND='web'; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 2; }
docker image inspect "${IMAGE}" >/dev/null 2>&1 || { echo "No such image: ${IMAGE}" >&2; exit 2; }

passed=0
failed=0
FAILURES=()

pass() { passed=$((passed + 1)); printf '  ok    %s\n' "$1"; }
fail() {
  failed=$((failed + 1))
  FAILURES+=("$1")
  printf '  FAIL  %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '        %s\n' "$2"
}

inspect() { docker image inspect --format "$1" "${IMAGE}"; }

# Runs a command inside the image without its entrypoint. `--network none` because
# nothing here needs one, and an inspection that could reach the network is an
# inspection that could be made to exfiltrate what it found.
in_image() {
  docker run --rm --network none --user 0:0 --entrypoint /bin/sh "${IMAGE}" -c "$1" 2>/dev/null
}

printf 'Verifying image %s\n' "${IMAGE}"

# ------------------------------------------------------------------------ identity

printf '\nProcess identity\n'

user="$(inspect '{{.Config.User}}')"

if [[ -n "${user}" && "${user}" != 'root' && "${user}" != '0' ]]; then
  pass "runs as ${user}, not root"
else
  fail 'runs as a non-root user' "Config.User is \"${user:-<empty>}\""
fi

entrypoint="$(inspect '{{join .Config.Entrypoint " "}}')"
cmd="$(inspect '{{join .Config.Cmd " "}}')"

# Node as PID 1, with nothing in front of it. Asserted as "no entrypoint at all, and a
# command that begins with node", not as "the word node appears somewhere": a wrapper
# script that forgets to `exec` swallows SIGTERM, `enableShutdownHooks` never runs, and
# every deploy kills in-flight work. The base image ships exactly such a wrapper — it
# does exec, but a check that tolerates one tolerates the next one too.
if [[ -z "${entrypoint}" && "${cmd}" == node\ * ]]; then
  pass "starts node directly (${cmd})"
else
  fail 'starts node directly, with no entrypoint wrapper' \
    "entrypoint=\"${entrypoint:-<none>}\" cmd=\"${cmd}\""
fi

if [[ "$(inspect '{{if .Config.Healthcheck}}yes{{end}}')" == 'yes' ]]; then
  pass 'declares a healthcheck'
else
  fail 'declares a healthcheck'
fi

ports="$(inspect '{{range $port, $_ := .Config.ExposedPorts}}{{$port}} {{end}}')"

[[ -n "${ports}" ]] \
  && pass "exposes ${ports}" \
  || fail 'exposes a port'

# ------------------------------------------------------------------ what must not be

printf '\nWhat must not be in the image\n'

# One traversal, several answers: starting a container is the expensive part.
findings="$(in_image '
  echo "ENV:$(find / -xdev -name ".env" -o -xdev -name ".env.*" 2>/dev/null | grep -v /node_modules/ | head -5 | tr "\n" " ")"
  echo "KEYS:$(find / -xdev \( -name "*.pem" -o -name "*.key" -o -name "*.p12" -o -name "*.pfx" \) 2>/dev/null | grep -v -e /node_modules/ -e /usr/lib/ssl -e /etc/ssl | head -5 | tr "\n" " ")"
  echo "GIT:$(find / -xdev -maxdepth 4 -name ".git" -type d 2>/dev/null | head -3 | tr "\n" " ")"
  echo "TS:$(find /app -xdev -name "*.ts" ! -name "*.d.ts" 2>/dev/null | grep -v /node_modules/ | head -5 | tr "\n" " ")"
  echo "PM:$(ls /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/pnpm 2>/dev/null | tr "\n" " ")"
  echo "LOCK:$(find /app -xdev -maxdepth 2 -name "pnpm-lock.yaml" 2>/dev/null | tr "\n" " ")"
')"

value_of() { printf '%s\n' "${findings}" | sed -n "s/^$1://p" | tr -d ' '; }

check_absent() {
  local key="$1" label="$2" found
  found="$(value_of "${key}")"

  if [[ -z "${found}" ]]; then
    pass "${label}"
  else
    fail "${label}" "found: ${found}"
  fi
}

check_absent ENV  'no .env file anywhere'
check_absent KEYS 'no private keys or certificates'
check_absent GIT  'no .git directory'
check_absent TS   'no TypeScript sources outside dependencies'
check_absent PM   'no package manager (npm, npx, corepack, yarn, pnpm)'
check_absent LOCK 'no lockfile'

# A secret can also arrive through the image *configuration*, which no filesystem scan
# would see. Anything that looks like a credential in a baked-in variable is a finding.
env_config="$(inspect '{{range .Config.Env}}{{println .}}{{end}}')"

if printf '%s' "${env_config}" \
  | grep -viE '^(NODE_ENV|PATH|API_HOST|API_PORT|PORT|HOSTNAME|UPLOAD_STORAGE_ROOT|NEXT_TELEMETRY_DISABLED|NODE_VERSION|YARN_VERSION|NEXT_PUBLIC_API_BASE_URL)=' \
  | grep -qiE '(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY)='; then
  fail 'no credential-shaped build-time environment variable' \
    "$(printf '%s' "${env_config}" | grep -iE '(SECRET|TOKEN|PASSWORD|CREDENTIAL|KEY)=' | sed 's/=.*/=<redacted>/' | tr '\n' ' ')"
else
  pass 'no credential-shaped build-time environment variable'
fi

# ---------------------------------------------------------------- what must be there

printf '\nWhat must be in the image\n'

case "${KIND}" in
  api)
    # OCR is not optional: scanned uploads run through this binary, and an image without
    # it degrades extraction silently rather than failing loudly.
    version="$(in_image 'tesseract --version 2>&1 | head -1')"

    [[ -n "${version}" ]] \
      && pass "tesseract is installed (${version})" \
      || fail 'tesseract is installed'

    in_image 'test -f /app/dist/main.js && echo yes' | grep -q yes \
      && pass 'the compiled entry point exists' \
      || fail 'the compiled entry point exists'

    # A workspace dependency that arrives as a dangling symlink is the classic failure
    # of copying a pnpm tree between stages: the build works, the container exits.
    in_image 'test -f /app/node_modules/@wdrg/contracts/dist/index.js && echo yes' | grep -q yes \
      && pass 'the workspace contracts package resolved to real files' \
      || fail 'the workspace contracts package resolved to real files' \
           'a symlink into a build stage that no longer exists would look like this'

    # The storage root has to be writable by the user the process runs as, or every
    # upload fails on a deployment that uses the filesystem adapter.
    in_image 'test -d /var/lib/wdrg/uploads && echo yes' | grep -q yes \
      && pass 'the upload storage root exists' \
      || fail 'the upload storage root exists'

    owner="$(in_image 'stat -c %U /var/lib/wdrg/uploads')"

    [[ "${owner}" == "${user}" ]] \
      && pass "the storage root is owned by ${user}" \
      || fail "the storage root is owned by ${user}" "owned by ${owner:-<unknown>}"
    ;;
  web)
    in_image 'test -f /app/apps/web/server.js && echo yes' | grep -q yes \
      && pass 'the standalone server exists' \
      || fail 'the standalone server exists'

    in_image 'test -d /app/apps/web/.next/static && echo yes' | grep -q yes \
      && pass 'the static assets are present' \
      || fail 'the static assets are present' 'without these every page renders unstyled'
    ;;
  *)
    printf '  note  no --api or --web given, so content checks were skipped\n'
    ;;
esac

# ----------------------------------------------------------------------------- size

size_bytes="$(inspect '{{.Size}}')"
printf '\nSize: %s MB\n' "$((size_bytes / 1000000))"

printf '\n%d passed, %d failed\n' "${passed}" "${failed}"

if (( failed > 0 )); then
  printf '\nFailed checks:\n'
  for name in "${FAILURES[@]}"; do printf '  - %s\n' "${name}"; done
  exit 1
fi

exit 0
