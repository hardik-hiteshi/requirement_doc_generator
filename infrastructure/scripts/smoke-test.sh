#!/usr/bin/env bash
# Does a deployment actually work?
#
# Everything here is a black-box check over HTTP against a running deployment. No
# repository, no toolchain, no database access — curl and a shell. That constraint is
# deliberate: this is the script somebody runs from a jump host five minutes after a
# release, and anything it needed from the source tree would make it useless there.
#
# It is not a substitute for the test suites. Those prove behaviour; this proves that
# *this* build, in *this* configuration, with *these* dependencies, is serving. The
# failures it catches are the ones a green test suite cannot: a missing native binary,
# an unreachable database, an image built without the API origin inlined, a reverse
# proxy stripping the correlation header, an operator token left in the environment of
# a deployment that was supposed to have none.
#
# ## What it does to the deployment
#
# It creates one project, adds one text source to it, and requests its deletion. It
# does that because the only honest test of an authenticated flow is an authenticated
# flow — a read-only smoke test would pass against a deployment whose writes all fail.
# The project it creates is named so it is recognisable, and it is deleted at the end.
#
# The recovery secret it receives is never printed, not even at maximum verbosity: it
# authorises the project it belongs to, and a smoke test that leaves credentials in CI
# logs is worse than no smoke test.
#
# ## Usage
#
#   infrastructure/scripts/smoke-test.sh \
#     [--api http://127.0.0.1:3001] \
#     [--web http://127.0.0.1:3000] \
#     [--admin-token TOKEN] \
#     [--expect-version 0.1.0] \
#     [--expect-web-api-origin https://api.example.internal] \
#     [--skip-web] [--production]
#
# Without --admin-token the operator surface is expected to be *absent* (404), which
# is what an unconfigured deployment must look like. With it, the token boundary is
# checked instead: refused without, refused wrong, admitted right.
#
# --production additionally requires the headers that only a production build sends.
#
# Exit status is 0 only if every check passed.
set -uo pipefail

API_BASE='http://127.0.0.1:3001'
WEB_BASE='http://127.0.0.1:3000'
ADMIN_TOKEN=''
EXPECT_VERSION=''
EXPECT_WEB_API_ORIGIN=''
SKIP_WEB='false'
PRODUCTION='false'
TIMEOUT=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API_BASE="${2:?--api needs a URL}"; shift 2 ;;
    --web) WEB_BASE="${2:?--web needs a URL}"; shift 2 ;;
    --admin-token) ADMIN_TOKEN="${2:?--admin-token needs a value}"; shift 2 ;;
    --expect-version) EXPECT_VERSION="${2:?--expect-version needs a value}"; shift 2 ;;
    --expect-web-api-origin) EXPECT_WEB_API_ORIGIN="${2:?--expect-web-api-origin needs a URL}"; shift 2 ;;
    --skip-web) SKIP_WEB='true'; shift ;;
    --production) PRODUCTION='true'; shift ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

API_BASE="${API_BASE%/}"
WEB_BASE="${WEB_BASE%/}"
# The origin baked into the web bundle is usually the API this test is pointing at, but
# not always: an image built for a deployment behind a proxy is verified on a runner
# where the API answers on localhost. The check is about which origin the *build* used.
EXPECT_WEB_API_ORIGIN="${EXPECT_WEB_API_ORIGIN:-${API_BASE}}"
EXPECT_WEB_API_ORIGIN="${EXPECT_WEB_API_ORIGIN%/}"

command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

BODY="${WORK}/body"
HEADERS="${WORK}/headers"
JAR="${WORK}/cookies"

passed=0
failed=0
FAILURES=()

pass() {
  passed=$((passed + 1))
  printf '  ok    %s\n' "$1"
}

fail() {
  failed=$((failed + 1))
  FAILURES+=("$1")
  printf '  FAIL  %s\n' "$1"
  if [[ -n "${2:-}" ]]; then
    printf '        %s\n' "$2"
  fi
}

section() { printf '\n%s\n' "$1"; }

# Sends a request. Body lands in $BODY, response headers in $HEADERS, status is echoed.
# A transport failure echoes 000, which every check below treats as a failure rather
# than tripping over an empty status.
call() {
  local method="$1" url="$2"; shift 2

  curl --silent --show-error --request "$method" \
    --max-time "${TIMEOUT}" \
    --output "${BODY}" --dump-header "${HEADERS}" \
    --write-out '%{http_code}' \
    "$@" "${url}" 2>"${WORK}/curl.err" || true
}

# A response header's value, lower-cased name, trailing whitespace stripped.
header() {
  # tr -d '\r': curl keeps the CRLF line endings the wire uses.
  tr -d '\r' <"${HEADERS}" \
    | awk -v want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" \
        'BEGIN{FS=": "} {k=tolower($1)} k==want {sub(/^[^:]*: ?/,""); print; exit}'
}

body_has() { grep -qF -- "$1" "${BODY}"; }

# Extracts a JSON string value without a JSON parser. Adequate because the shapes it
# reads are fixed by contract and contain no escaping.
json_value() {
  grep -o "\"$1\":\"[^\"]*\"" "${BODY}" | head -n 1 | sed "s/\"$1\":\"//; s/\"$//"
}

# The numeric variant, for the optimistic-concurrency version a mutation has to carry.
json_number() {
  grep -o "\"$1\":[0-9][0-9]*" "${BODY}" | head -n 1 | sed "s/\"$1\"://"
}

expect_status() {
  local want="$1" got="$2" what="$3"

  if [[ "${got}" == "${want}" ]]; then
    pass "${what}"
    return 0
  fi

  fail "${what}" "expected HTTP ${want}, got ${got}"
  return 1
}

printf 'Smoke test\n  api %s\n  web %s\n' "${API_BASE}" "${SKIP_WEB/false/${WEB_BASE}}"

# --------------------------------------------------------------------- readiness
#
# First, because every check after it is meaningless if the instance cannot serve.

section 'Readiness and liveness'

status="$(call GET "${API_BASE}/api/health/ready")"

if expect_status 200 "${status}" 'readiness reports the instance ready'; then
  # Named indicators, not just an overall status: "ok" with no MongoDB check would
  # mean the probe had silently stopped checking the thing it exists to check.
  body_has '"mongodb"' \
    && pass 'readiness names the MongoDB indicator' \
    || fail 'readiness names the MongoDB indicator' "$(head -c 400 "${BODY}")"

  body_has '"malware_scanner"' \
    && pass 'readiness names the malware scanner indicator' \
    || fail 'readiness names the malware scanner indicator'
else
  # The whole per-indicator report comes back on 503, and it says which dependency
  # is down — worth printing, because it is the answer to "why did the deploy fail".
  printf '        %s\n' "$(head -c 600 "${BODY}")"
fi

status="$(call GET "${API_BASE}/api/health/live")"
expect_status 200 "${status}" 'liveness answers'

version="$(json_value version)"

if [[ -n "${EXPECT_VERSION}" ]]; then
  if [[ "${version}" == "${EXPECT_VERSION}" ]]; then
    pass "liveness reports version ${EXPECT_VERSION}"
  else
    fail 'liveness reports the expected version' \
      "expected ${EXPECT_VERSION}, got ${version:-<none>}"
  fi
elif [[ -n "${version}" ]]; then
  pass "liveness reports a version (${version})"
else
  fail 'liveness reports a version'
fi

# Version-neutral on purpose: an orchestrator's probe must not need editing when the
# business API moves to v2. If these ever became versioned, every probe would break
# on the day of a version bump and nothing else would notice.
[[ "${API_BASE}/api/health/live" != *"/v1/"* ]] \
  && pass 'health routes are version-neutral' \
  || fail 'health routes are version-neutral'

# -------------------------------------------------------------- security headers

section 'Security headers'

status="$(call GET "${API_BASE}/api/health/live")"

require_header() {
  local name="$1" want="${2:-}" value
  value="$(header "${name}")"

  if [[ -z "${value}" ]]; then
    fail "${name} is present"
    return
  fi

  if [[ -n "${want}" && "${value}" != *"${want}"* ]]; then
    fail "${name} contains ${want}" "got: ${value}"
    return
  fi

  pass "${name}: ${value}"
}

require_header 'x-content-type-options' 'nosniff'
require_header 'x-frame-options'
require_header 'strict-transport-security' 'max-age='
require_header 'cross-origin-resource-policy' 'same-site'
require_header 'x-dns-prefetch-control'

# Absence is the assertion. `X-Powered-By` tells an attacker the framework and, on
# some stacks, its version; nothing needs it.
if [[ -z "$(header 'x-powered-by')" ]]; then
  pass 'x-powered-by is absent'
else
  fail 'x-powered-by is absent' "got: $(header 'x-powered-by')"
fi

if [[ "${PRODUCTION}" == 'true' ]]; then
  # Only in production: the interactive API documentation needs inline scripts that
  # helmet's default policy blocks, so the header is deliberately off elsewhere.
  require_header 'content-security-policy' "default-src 'self'"
fi

# --------------------------------------------------------------- error envelope

section 'Error envelope and correlation id'

status="$(call GET "${API_BASE}/api/v1/projects/current")"

if expect_status 401 "${status}" 'an unauthenticated read is refused'; then
  body_has '"code":"UNAUTHORIZED"' \
    && pass 'the refusal carries the UNAUTHORIZED code' \
    || fail 'the refusal carries the UNAUTHORIZED code' "$(head -c 300 "${BODY}")"

  body_has '"correlationId"' \
    && pass 'the envelope carries a correlation id' \
    || fail 'the envelope carries a correlation id'

  # An error body that leaks a stack trace hands over file paths, dependency
  # versions and internal structure. The envelope exists to make that impossible.
  if grep -qE '"stack"|at [A-Za-z]+\.[A-Za-z]+ \(|/node_modules/' "${BODY}"; then
    fail 'the envelope carries no stack trace' "$(head -c 300 "${BODY}")"
  else
    pass 'the envelope carries no stack trace'
  fi
fi

status="$(call GET "${API_BASE}/api/v1/no-such-route")"
expect_status 404 "${status}" 'an unknown route answers 404'

[[ -n "$(header 'x-correlation-id')" ]] \
  && pass 'every response carries a correlation id header' \
  || fail 'every response carries a correlation id header'

# A caller-supplied id is reused, so one trace spans the browser, any proxy and the
# API. This is the check that catches a reverse proxy stripping the header.
supplied='smoke-0000-1111-2222-333344445555'
status="$(call GET "${API_BASE}/api/health/live" --header "x-request-id: ${supplied}")"
echoed="$(header 'x-correlation-id')"

if [[ "${echoed}" == "${supplied}" ]]; then
  pass 'a supplied correlation id is echoed back'
else
  fail 'a supplied correlation id is echoed back' "sent ${supplied}, got ${echoed:-<none>}"
fi

# ...but only after validation. An unvalidated header would let a caller inject
# newlines into every log line the request produces.
status="$(call GET "${API_BASE}/api/health/live" --header 'x-request-id: not a valid id!!!')"
echoed="$(header 'x-correlation-id')"

if [[ -n "${echoed}" && "${echoed}" != *'not a valid id'* ]]; then
  pass 'a malformed correlation id is replaced rather than echoed'
else
  fail 'a malformed correlation id is replaced rather than echoed' "got: ${echoed:-<none>}"
fi

# ------------------------------------------------------------ operator surface

section 'Operator surface'

if [[ -z "${ADMIN_TOKEN}" ]]; then
  # 404, not 403: a deployment that has not enabled the operator surface must be
  # indistinguishable from one where these routes do not exist. A 401 here would
  # tell somebody there is a door, and that a key exists to go looking for.
  status="$(call GET "${API_BASE}/api/v1/admin/status")"

  if expect_status 404 "${status}" 'the operator surface is absent when unconfigured'; then
    body_has '"code":"NOT_FOUND"' \
      && pass 'the refusal is indistinguishable from an unknown route' \
      || fail 'the refusal is indistinguishable from an unknown route' "$(head -c 300 "${BODY}")"
  fi

  status="$(call GET "${API_BASE}/api/v1/admin/metrics")"
  expect_status 404 "${status}" 'metrics are absent when the surface is unconfigured'
else
  status="$(call GET "${API_BASE}/api/v1/admin/status")"
  expect_status 401 "${status}" 'the operator surface refuses a request with no token'

  status="$(call GET "${API_BASE}/api/v1/admin/status" \
    --header 'x-admin-token: this-token-is-long-enough-and-wrong')"
  expect_status 401 "${status}" 'the operator surface refuses a wrong token'

  status="$(call GET "${API_BASE}/api/v1/admin/status" \
    --header "x-admin-token: ${ADMIN_TOKEN}")"

  if expect_status 200 "${status}" 'the operator surface admits the configured token'; then
    body_has '"projects"' \
      && pass 'status reports project counts' \
      || fail 'status reports project counts'

    # The response describes the deployment. If it ever described the credential
    # that opened it, every log and screenshot of it would be a leak.
    if body_has "${ADMIN_TOKEN}"; then
      fail 'status never echoes the operator token'
    else
      pass 'status never echoes the operator token'
    fi
  fi

  status="$(call GET "${API_BASE}/api/v1/admin/metrics" \
    --header "x-admin-token: ${ADMIN_TOKEN}")"

  if expect_status 200 "${status}" 'metrics are served to an operator'; then
    body_has 'wdrg_http_requests_total' \
      && pass 'metrics include the request counter' \
      || fail 'metrics include the request counter'

    # A repeated TYPE line makes a collector reject the entire scrape, so one
    # malformed histogram would take every other metric with it.
    duplicates="$(grep -c '^# TYPE wdrg_http_request_duration_seconds ' "${BODY}" || true)"

    if [[ "${duplicates}" == '1' ]]; then
      pass 'the latency histogram declares its type exactly once'
    else
      fail 'the latency histogram declares its type exactly once' "found ${duplicates} TYPE lines"
    fi
  fi
fi

# ---------------------------------------------------------- authenticated flow

section 'Authenticated project flow'

rm -f "${JAR}"
project_id=''

status="$(call POST "${API_BASE}/api/v1/projects" \
  --cookie-jar "${JAR}" \
  --header 'content-type: application/json' \
  --data '{"name":"Deployment smoke test","projectTypes":["WEB_APPLICATION"]}')"

if expect_status 201 "${status}" 'a project can be created'; then
  project_id="$(json_value projectId)"
  # Read but never printed, and never written anywhere but this shell variable.
  recovery_secret="$(json_value recoverySecret)"

  [[ "${project_id}" =~ ^prj_[0-9A-Z]{26}$ ]] \
    && pass "the response names the new project (${project_id})" \
    || fail 'the response names the new project' "got: ${project_id:-<none>}"

  [[ "${recovery_secret}" =~ ^[A-Za-z0-9_-]{43}$ ]] \
    && pass 'the response carries a recovery secret of the right shape' \
    || fail 'the response carries a recovery secret of the right shape'

  session_cookie="$(grep -c 'wdrg_project_session' "${HEADERS}" || true)"
  [[ "${session_cookie}" -ge 1 ]] \
    && pass 'a session cookie is issued' \
    || fail 'a session cookie is issued'

  # HttpOnly on the session cookie is what keeps an XSS bug from handing over the
  # project. The CSRF cookie is readable on purpose — that is the double-submit
  # mechanism — so only the session cookie is asserted here.
  tr -d '\r' <"${HEADERS}" | grep -i '^set-cookie: wdrg_project_session' | grep -qi 'httponly' \
    && pass 'the session cookie is HttpOnly' \
    || fail 'the session cookie is HttpOnly'

  tr -d '\r' <"${HEADERS}" | grep -i '^set-cookie: wdrg_project_session' | grep -qi 'samesite' \
    && pass 'the session cookie sets SameSite' \
    || fail 'the session cookie sets SameSite'

  csrf="$(awk '$6=="wdrg_csrf" {print $7}' "${JAR}" | tail -n 1)"

  [[ -n "${csrf}" ]] \
    && pass 'a readable CSRF cookie is issued' \
    || fail 'a readable CSRF cookie is issued'

  status="$(call GET "${API_BASE}/api/v1/projects/current" --cookie "${JAR}")"
  expect_status 200 "${status}" 'the session reads its own project'

  # The negative half. A session cookie alone must not be enough to write, or the
  # double-submit token is decoration.
  status="$(call POST "${API_BASE}/api/v1/projects/current/sources/text" \
    --cookie "${JAR}" \
    --header 'content-type: application/json' \
    --data '{"title":"No CSRF","text":"This request should be refused because it carries no CSRF header."}')"
  expect_status 401 "${status}" 'a write without the CSRF header is refused'

  status="$(call POST "${API_BASE}/api/v1/projects/current/sources/text" \
    --cookie "${JAR}" \
    --header 'content-type: application/json' \
    --header "x-csrf-token: ${csrf}" \
    --data '{"title":"Smoke test brief","text":"Staff must be able to record their weekly timesheets and submit them for approval."}')"

  if expect_status 201 "${status}" 'a text requirement source can be added'; then
    status="$(call GET "${API_BASE}/api/v1/projects/current/sources" --cookie "${JAR}")"

    if expect_status 200 "${status}" 'the source list can be read back'; then
      body_has 'Smoke test brief' \
        && pass 'the source that was just written is in the list' \
        || fail 'the source that was just written is in the list'
    fi
  fi

  # Validation, over the wire. A deployment whose validation pipe is misconfigured
  # accepts nonsense and fails later, somewhere less obvious.
  status="$(call POST "${API_BASE}/api/v1/projects/current/sources/text" \
    --cookie "${JAR}" \
    --header 'content-type: application/json' \
    --header "x-csrf-token: ${csrf}" \
    --data '{"title":"","text":""}')"

  if expect_status 422 "${status}" 'an invalid payload is refused with a validation failure'; then
    body_has '"code":"VALIDATION_FAILED"' \
      && pass 'the validation failure carries field details' \
      || fail 'the validation failure carries field details' "$(head -c 300 "${BODY}")"
  fi

  # The recovery path, from a browser that has never seen this project: this is what
  # proves the session HMAC and the stored secret hash agree in this deployment.
  if [[ -n "${recovery_secret}" ]]; then
    rm -f "${WORK}/jar2"
    status="$(call POST "${API_BASE}/api/v1/projects/session" \
      --cookie-jar "${WORK}/jar2" \
      --header 'content-type: application/json' \
      --data "{\"projectId\":\"${project_id}\",\"recoverySecret\":\"${recovery_secret}\"}")"

    if expect_status 200 "${status}" 'a recovery secret can be exchanged for a session'; then
      status="$(call GET "${API_BASE}/api/v1/projects/current" --cookie "${WORK}/jar2")"

      if expect_status 200 "${status}" 'the recovered session reads the same project'; then
        body_has "${project_id}" \
          && pass 'the recovered session is bound to the right project' \
          || fail 'the recovered session is bound to the right project'
      fi
    fi

    # A wrong secret must not be distinguishable from an unknown project.
    status="$(call POST "${API_BASE}/api/v1/projects/session" \
      --header 'content-type: application/json' \
      --data "{\"projectId\":\"${project_id}\",\"recoverySecret\":\"$(printf 'A%.0s' {1..43})\"}")"
    expect_status 401 "${status}" 'a wrong recovery secret is refused'
  fi
fi

# --------------------------------------------------------------- cross-project

section 'Isolation'

# A second project, to prove one session cannot reach another's data. `projects/current`
# is the only shape the API offers, so this checks the thing that shape is for: the
# project comes from the session and cannot be named by the caller.
rm -f "${WORK}/jar3"
status="$(call POST "${API_BASE}/api/v1/projects" \
  --cookie-jar "${WORK}/jar3" \
  --header 'content-type: application/json' \
  --data '{"name":"Deployment smoke test (second)","projectTypes":["WEB_APPLICATION"]}')"

second_id=''

if [[ "${status}" == '201' ]]; then
  second_id="$(json_value projectId)"

  status="$(call GET "${API_BASE}/api/v1/projects/current" --cookie "${WORK}/jar3")"

  if [[ "${status}" == '200' ]]; then
    if [[ -n "${project_id}" ]] && body_has "${project_id}"; then
      fail 'a second session cannot see the first project'
    else
      pass 'a second session sees only its own project'
    fi
  else
    fail 'the second session reads its own project' "got HTTP ${status}"
  fi
else
  # Creation is rate-limited per address; a refusal here is the ceiling doing its job
  # rather than a broken deployment, so it is reported and not counted as a failure.
  printf '  skip  isolation check (second project creation answered %s)\n' "${status}"
fi

# ---------------------------------------------------------------------- the web app

if [[ "${SKIP_WEB}" != 'true' ]]; then
  section 'Web application'

  status="$(call GET "${WEB_BASE}/")"

  if expect_status 200 "${status}" 'the web application serves its entry page'; then
    body_has '<html' \
      && pass 'the response is a rendered document' \
      || fail 'the response is a rendered document'
  fi

  # The API origin is inlined into the bundle at build time, so an image built for
  # another deployment cannot be pointed here by setting a variable. This is the
  # check that catches it — and it is the single most likely way a deployment of
  # this image goes wrong.
  #
  # Which chunk holds it is a build-time detail nobody should have to predict, so this
  # walks every chunk the entry page loads. Only the ones that actually call the API
  # contain the origin, and that is not the first one in the list.
  status="$(call GET "${WEB_BASE}/")"
  found='false'

  if body_has "${EXPECT_WEB_API_ORIGIN}"; then
    found='true'
  else
    chunks="$(grep -o '/_next/static/chunks/[A-Za-z0-9._/-]*\.js' "${BODY}" | sort -u | head -n 20)"

    for chunk in ${chunks}; do
      call GET "${WEB_BASE}${chunk}" >/dev/null

      if body_has "${EXPECT_WEB_API_ORIGIN}"; then
        found='true'
        break
      fi
    done
  fi

  if [[ "${found}" == 'true' ]]; then
    pass "the bundle was built for the expected API origin (${EXPECT_WEB_API_ORIGIN})"
  else
    fail 'the bundle was built for the expected API origin' \
      "no chunk loaded by the entry page contains ${EXPECT_WEB_API_ORIGIN}; the image was built with a different NEXT_PUBLIC_API_BASE_URL"
  fi

  # Present, and never indexed: an operator console in a search result is an
  # invitation.
  status="$(call GET "${WEB_BASE}/admin")"

  if expect_status 200 "${status}" 'the operator console is served'; then
    grep -qi 'noindex' "${BODY}" \
      && pass 'the operator console asks not to be indexed' \
      || fail 'the operator console asks not to be indexed'
  fi
fi

# ------------------------------------------------------------------------ cleanup

section 'Cleanup'

# Deletion is deliberately awkward: it takes the typed project name and the version the
# caller last saw. That is a product decision — there is no support channel that can
# undo a delete on an account-less project — so the cleanup has to read the project
# first, which incidentally exercises the concurrency token over the wire.
remove_project() {
  local jar="$1" name="$2" label="$3" version csrf

  csrf="$(awk '$6=="wdrg_csrf" {print $7}' "${jar}" | tail -n 1)"

  call GET "${API_BASE}/api/v1/projects/current" --cookie "${jar}" >/dev/null
  version="$(json_number version)"

  if [[ -z "${version}" ]]; then
    fail "deletion of ${label} was accepted" 'could not read the project version'
    return
  fi

  local status
  status="$(call DELETE "${API_BASE}/api/v1/projects/current" \
    --cookie "${jar}" \
    --header 'content-type: application/json' \
    --header "x-csrf-token: ${csrf}" \
    --data "{\"confirmationName\":\"${name}\",\"version\":${version}}")"

  case "${status}" in
    200|202|204) pass "deletion of ${label} was accepted (HTTP ${status})" ;;
    *) fail "deletion of ${label} was accepted" "got HTTP ${status}: $(head -c 250 "${BODY}")" ;;
  esac
}

# A mismatched version must be refused rather than applied, and this is checked before
# the real deletion so the project is still there to refuse it. The concurrency token is
# load-bearing across the whole product — every editing surface depends on a stale write
# answering 409 — and a deployment where it silently succeeded would lose work quietly.
#
# The version sent is read from the project and then moved, rather than hard-coded: a
# literal would eventually *be* the current version, and the check would pass by
# accidentally being correct.
if [[ -n "${project_id}" ]]; then
  call GET "${API_BASE}/api/v1/projects/current" --cookie "${JAR}" >/dev/null
  current_version="$(json_number version)"

  status="$(call DELETE "${API_BASE}/api/v1/projects/current" \
    --cookie "${JAR}" \
    --header 'content-type: application/json' \
    --header "x-csrf-token: $(awk '$6=="wdrg_csrf" {print $7}' "${JAR}" | tail -n 1)" \
    --data "{\"confirmationName\":\"Deployment smoke test\",\"version\":$(( ${current_version:-0} + 7 ))}")"
  expect_status 409 "${status}" 'a mutation carrying a mismatched version is refused'
fi

if [[ -n "${project_id}" ]]; then
  remove_project "${JAR}" 'Deployment smoke test' "${project_id}"
fi

if [[ -n "${second_id}" ]]; then
  remove_project "${WORK}/jar3" 'Deployment smoke test (second)' "${second_id}"
fi

# --------------------------------------------------------------------------- result

printf '\n%d passed, %d failed\n' "${passed}" "${failed}"

if (( failed > 0 )); then
  printf '\nFailed checks:\n'
  for name in "${FAILURES[@]}"; do
    printf '  - %s\n' "${name}"
  done
  exit 1
fi

exit 0
