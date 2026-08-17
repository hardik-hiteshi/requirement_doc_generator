#!/usr/bin/env bash
# Proves the backup can be restored, by destroying data and getting it back.
#
# A backup procedure nobody has restored from is a hypothesis. This script turns it into
# a fact, end to end and unattended:
#
#   1. Starts the API image against a throwaway database and a throwaway upload volume.
#   2. Creates a project, adds a pasted requirement source, and uploads a real file
#      through the real ingestion path — scanner and all.
#   3. Records what exists: project id, source count, and the sha256 of the file as the
#      API hands it back on download.
#   4. Takes a backup with backup.sh.
#   5. **Destroys it.** Drops the database and empties the upload volume.
#   6. Confirms the destruction was real — the recovery secret no longer opens anything
#      and the storage root is empty. Without this step a "successful restore" could be
#      a restore that never had to do anything.
#   7. Restores with restore.sh.
#   8. Verifies: the recovery secret opens the project again, the sources are all there,
#      and the uploaded file downloads byte-for-byte identical to what went in.
#
# Step 8 is the whole point. Row counts prove a restore wrote something; a checksum of
# the file the application serves back proves the two halves of the backup — database
# and object bytes — still refer to each other.
#
# ## What it is safe to run against
#
# Nothing it does not create. The database name must contain "rehearsal" and the upload
# volume is created and removed by this script, because step 5 drops a database and
# empties a volume and a typo there would be unrecoverable.
#
# It does need somewhere to talk to: an existing MongoDB and ClamAV on a Docker network,
# which the development compose stack already provides.
#
#   pnpm docker:up
#   docker build -f infrastructure/docker/api.Dockerfile -t wdrg-api:local .
#   infrastructure/scripts/restore-rehearsal.sh
set -uo pipefail

NETWORK='wdrg-dev_default'
MONGO_HOST='mongodb'
CLAMAV_HOST='clamav'
DATABASE='wdrg_restore_rehearsal'
API_IMAGE='wdrg-api:local'
MONGO_IMAGE='mongo:8.0'
HOST_PORT='3399'
KEEP='false'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="${2:?}"; shift 2 ;;
    --mongo-host) MONGO_HOST="${2:?}"; shift 2 ;;
    --clamav-host) CLAMAV_HOST="${2:?}"; shift 2 ;;
    --database) DATABASE="${2:?}"; shift 2 ;;
    --api-image) API_IMAGE="${2:?}"; shift 2 ;;
    --port) HOST_PORT="${2:?}"; shift 2 ;;
    --keep) KEEP='true'; shift ;;
    -h|--help) sed -n '2,38p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The guard on step 5. Everything else here is reversible; dropping a database is not.
case "${DATABASE}" in
  *rehearsal*) ;;
  *)
    echo "Refusing to run against \"${DATABASE}\": this script drops the database it" >&2
    echo 'is pointed at, so the name must contain "rehearsal".' >&2
    exit 2
    ;;
esac

command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 2; }
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="wdrg-rehearsal-api"
VOLUME="wdrg-rehearsal-uploads"
URI="mongodb://${MONGO_HOST}:27017/${DATABASE}"
API="http://127.0.0.1:${HOST_PORT}"

WORK="$(mktemp -d)"
BACKUP_ROOT="${WORK}/backups"

step=0
failures=0

announce() {
  step=$((step + 1))
  printf '\n=== %d. %s\n' "${step}" "$1"
}

ok()   { printf '  ok    %s\n' "$1"; }
bad()  { failures=$((failures + 1)); printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; }

cleanup() {
  if [[ "${KEEP}" == 'true' ]]; then
    printf '\nLeaving %s, volume %s and %s in place (--keep).\n' "${CONTAINER}" "${VOLUME}" "${WORK}"
    return
  fi

  printf '\nCleaning up...\n'
  docker rm -f "${CONTAINER}" >/dev/null 2>&1
  docker run --rm --network "${NETWORK}" "${MONGO_IMAGE}" \
    mongosh "${URI}" --quiet --eval 'db.dropDatabase()' >/dev/null 2>&1
  docker volume rm -f "${VOLUME}" >/dev/null 2>&1
  rm -rf "${WORK}"
}
trap cleanup EXIT

mongo_eval() {
  docker run --rm --network "${NETWORK}" "${MONGO_IMAGE}" \
    mongosh "${URI}" --quiet --eval "$1" 2>/dev/null
}

# Status is echoed; body goes to $1.
call() {
  local out="$1" method="$2" url="$3"; shift 3
  curl --silent --show-error --request "${method}" \
    --max-time 30 --output "${out}" --dump-header "${WORK}/headers" \
    --write-out '%{http_code}' "$@" "${url}" 2>/dev/null || true
}

json_value() { grep -o "\"$2\":\"[^\"]*\"" "$1" | head -n 1 | sed "s/\"$2\":\"//; s/\"$//"; }

printf 'Restore rehearsal\n  network:  %s\n  database: %s\n  image:    %s\n' \
  "${NETWORK}" "${DATABASE}" "${API_IMAGE}"

# ------------------------------------------------------------------------- 1. start

announce 'Starting the API image against a throwaway database'

docker rm -f "${CONTAINER}" >/dev/null 2>&1
docker volume rm -f "${VOLUME}" >/dev/null 2>&1
mongo_eval 'db.dropDatabase()' >/dev/null

# Random, and thrown away with the container. Production refuses the development
# placeholder, and this runs with NODE_ENV=production precisely so that it is the
# production configuration path being rehearsed.
SESSION_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=' | cut -c1-48)"

docker run -d --name "${CONTAINER}" \
  --network "${NETWORK}" \
  --publish "127.0.0.1:${HOST_PORT}:3001" \
  --volume "${VOLUME}:/var/lib/wdrg/uploads" \
  --env NODE_ENV=production \
  --env "MONGODB_URI=${URI}" \
  --env LOG_LEVEL=warn \
  --env STORAGE_ADAPTER=filesystem \
  --env UPLOAD_STORAGE_ROOT=/var/lib/wdrg/uploads \
  --env MALWARE_SCANNER=clamav \
  --env "CLAMAV_HOST=${CLAMAV_HOST}" \
  --env CLAMAV_PORT=3310 \
  --env AI_PROVIDER=disabled \
  --env EXTRACTION_WORKER_ENABLED=true \
  --env RETENTION_ENABLED=false \
  --env "PROJECT_SESSION_SECRET=${SESSION_SECRET}" \
  --env "API_PUBLIC_URL=${API}" \
  --env "WEB_PUBLIC_URL=http://127.0.0.1:3000" \
  "${API_IMAGE}" >/dev/null || { bad 'the API container started'; exit 1; }

printf '  waiting for readiness'
ready='false'

for _ in $(seq 1 60); do
  if [[ "$(call "${WORK}/ready" GET "${API}/api/health/ready")" == '200' ]]; then
    ready='true'
    break
  fi
  printf '.'
  sleep 2
done

printf '\n'

if [[ "${ready}" != 'true' ]]; then
  bad 'the API reports ready' "$(docker logs --tail 30 "${CONTAINER}" 2>&1)"
  exit 1
fi

ok 'the API image is running and reports ready'

# -------------------------------------------------------------------------- 2. seed

announce 'Creating data worth losing'

status="$(call "${WORK}/created" POST "${API}/api/v1/projects" \
  --cookie-jar "${WORK}/jar" \
  --header 'content-type: application/json' \
  --data '{"name":"Restore rehearsal","projectTypes":["WEB_APPLICATION"]}')"

if [[ "${status}" != '201' ]]; then
  bad 'a project was created' "HTTP ${status}: $(head -c 300 "${WORK}/created")"
  exit 1
fi

PROJECT_ID="$(json_value "${WORK}/created" projectId)"
# Held only in this variable, and never printed: it authorises the project.
RECOVERY_SECRET="$(json_value "${WORK}/created" recoverySecret)"
CSRF="$(awk '$6=="wdrg_csrf" {print $7}' "${WORK}/jar" | tail -n 1)"

ok "project ${PROJECT_ID} created"

status="$(call "${WORK}/text" POST "${API}/api/v1/projects/current/sources/text" \
  --cookie "${WORK}/jar" \
  --header 'content-type: application/json' \
  --header "x-csrf-token: ${CSRF}" \
  --data '{"title":"Rehearsal brief","text":"Staff must be able to record their weekly timesheets and submit them for approval before payroll closes."}')"

[[ "${status}" == '201' ]] \
  && ok 'a pasted requirement source was added' \
  || bad 'a pasted requirement source was added' "HTTP ${status}"

# A real upload, through the real path: scanned, stored on the volume, extracted. This
# is the half of the backup that a database dump alone would miss.
UPLOAD="${WORK}/rehearsal-requirements.txt"
cat > "${UPLOAD}" <<'CONTENT'
Timesheet portal — requirements
1. A member of staff records hours against a project, per day.
2. A line manager approves or returns a submitted week.
3. Payroll exports approved weeks as CSV.
CONTENT

UPLOAD_SHA="$(sha256sum "${UPLOAD}" | cut -d' ' -f1)"

status="$(call "${WORK}/upload" POST "${API}/api/v1/projects/current/sources/files" \
  --cookie "${WORK}/jar" \
  --header "x-csrf-token: ${CSRF}" \
  --form "files=@${UPLOAD};type=text/plain")"

SOURCE_ID=''

# The upload endpoint reports per-file outcomes rather than failing the request, so a
# 201 alone would also cover "accepted: false, rejected by the scanner".
if [[ "${status}" == '201' ]] && grep -q '"accepted":true' "${WORK}/upload"; then
  ok 'a file was uploaded, scanned and stored'
  SOURCE_ID="$(json_value "${WORK}/upload" sourceId)"
else
  bad 'a file was uploaded, scanned and stored' "HTTP ${status}: $(head -c 400 "${WORK}/upload")"
fi

BEFORE_SOURCES="$(mongo_eval 'db.requirement_sources.countDocuments({})' | tr -dc '0-9')"
BEFORE_FILES="$(docker run --rm --volume "${VOLUME}:/uploads:ro" "${MONGO_IMAGE}" \
  sh -c 'find /uploads -type f | wc -l' | tr -dc '0-9')"

printf '  recorded state: %s source(s) in the database, %s file(s) in the storage root\n' \
  "${BEFORE_SOURCES}" "${BEFORE_FILES}"

# Asserted to be non-trivial, not merely equal to what comes back later. The first
# version of this script counted the wrong collection, so "before" and "after" were
# both zero and the comparison passed while proving nothing at all.
[[ "${BEFORE_SOURCES:-0}" -ge 2 ]] \
  && ok "both sources are in the database (${BEFORE_SOURCES})" \
  || bad 'both sources are in the database' \
       "counted ${BEFORE_SOURCES:-0}; a later count that matches this would prove nothing"

[[ "${BEFORE_FILES:-0}" -ge 1 ]] \
  && ok 'the upload really is on the volume' \
  || bad 'the upload really is on the volume' 'the uploads half of the backup would be empty'

# ------------------------------------------------------------------------ 3. backup

announce 'Taking a backup'

if bash "${REPO_ROOT}/infrastructure/scripts/backup.sh" \
  --uri "${URI}" \
  --network "${NETWORK}" \
  --uploads-volume "${VOLUME}" \
  --output-dir "${BACKUP_ROOT}" \
  --label rehearsal; then
  ok 'backup.sh completed'
else
  bad 'backup.sh completed'
  exit 1
fi

BACKUP_DIR="$(find "${BACKUP_ROOT}" -maxdepth 1 -mindepth 1 -type d | sort | tail -n 1)"

[[ -n "${BACKUP_DIR}" ]] || { bad 'the backup directory exists'; exit 1; }

(cd "${BACKUP_DIR}" && sha256sum -c SHA256SUMS >/dev/null 2>&1) \
  && ok 'the archive verifies against its own checksums' \
  || bad 'the archive verifies against its own checksums'

# ----------------------------------------------------------------------- 4. destroy

announce 'Destroying the data'

# Stopped first: restoring underneath a running process is not what a real recovery
# looks like, and an in-flight write during the drop would muddy what follows.
docker stop "${CONTAINER}" >/dev/null

mongo_eval 'db.dropDatabase()' >/dev/null
docker run --rm --volume "${VOLUME}:/uploads" "${MONGO_IMAGE}" \
  sh -c 'rm -rf /uploads/* /uploads/.[!.]* 2>/dev/null; true' >/dev/null

GONE_SOURCES="$(mongo_eval 'db.requirement_sources.countDocuments({})' | tr -dc '0-9')"
GONE_PROJECTS="$(mongo_eval 'db.projects.countDocuments({})' | tr -dc '0-9')"
GONE_FILES="$(docker run --rm --volume "${VOLUME}:/uploads:ro" "${MONGO_IMAGE}" \
  sh -c 'find /uploads -type f | wc -l' | tr -dc '0-9')"

[[ "${GONE_SOURCES:-0}" == '0' && "${GONE_PROJECTS:-0}" == '0' ]] \
  && ok 'the database is empty' \
  || bad 'the database is empty' \
       "still ${GONE_PROJECTS:-0} project(s) and ${GONE_SOURCES:-0} source(s)"

[[ "${GONE_FILES:-0}" == '0' ]] \
  && ok 'the storage root is empty' \
  || bad 'the storage root is empty' "still ${GONE_FILES} file(s)"

docker start "${CONTAINER}" >/dev/null
for _ in $(seq 1 30); do
  [[ "$(call "${WORK}/ready" GET "${API}/api/health/ready")" == '200' ]] && break
  sleep 2
done

# The proof that the destruction was real, taken through the API rather than the
# database: the credential that opened this project a minute ago now opens nothing.
status="$(call "${WORK}/gone" POST "${API}/api/v1/projects/session" \
  --header 'content-type: application/json' \
  --data "{\"projectId\":\"${PROJECT_ID}\",\"recoverySecret\":\"${RECOVERY_SECRET}\"}")"

[[ "${status}" == '401' || "${status}" == '404' ]] \
  && ok "the project is unreachable through the API (HTTP ${status})" \
  || bad 'the project is unreachable through the API' "HTTP ${status} — the destruction did not take"

# ----------------------------------------------------------------------- 5. restore

announce 'Restoring'

docker stop "${CONTAINER}" >/dev/null

if bash "${REPO_ROOT}/infrastructure/scripts/restore.sh" \
  --from "${BACKUP_DIR}" \
  --uri "${URI}" \
  --network "${NETWORK}" \
  --uploads-volume "${VOLUME}"; then
  ok 'restore.sh completed'
else
  bad 'restore.sh completed'
  exit 1
fi

docker start "${CONTAINER}" >/dev/null
printf '  waiting for readiness'

for _ in $(seq 1 30); do
  if [[ "$(call "${WORK}/ready" GET "${API}/api/health/ready")" == '200' ]]; then break; fi
  printf '.'
  sleep 2
done

printf '\n'

# ------------------------------------------------------------------------ 6. verify

announce 'Verifying the restore through the API'

AFTER_SOURCES="$(mongo_eval 'db.requirement_sources.countDocuments({})' | tr -dc '0-9')"

[[ "${AFTER_SOURCES}" == "${BEFORE_SOURCES}" && "${AFTER_SOURCES:-0}" -ge 2 ]] \
  && ok "source count matches (${AFTER_SOURCES})" \
  || bad 'source count matches' "before ${BEFORE_SOURCES}, after ${AFTER_SOURCES}"

# The credential works again — which means the salted hash of the recovery secret and
# the session HMAC both came back intact, not just the row count.
status="$(call "${WORK}/recovered" POST "${API}/api/v1/projects/session" \
  --cookie-jar "${WORK}/jar-restored" \
  --header 'content-type: application/json' \
  --data "{\"projectId\":\"${PROJECT_ID}\",\"recoverySecret\":\"${RECOVERY_SECRET}\"}")"

if [[ "${status}" == '200' ]]; then
  ok 'the recovery secret opens the restored project'
else
  bad 'the recovery secret opens the restored project' "HTTP ${status}: $(head -c 300 "${WORK}/recovered")"
fi

status="$(call "${WORK}/sources" GET "${API}/api/v1/projects/current/sources" \
  --cookie "${WORK}/jar-restored")"

if [[ "${status}" == '200' ]]; then
  grep -qF 'Rehearsal brief' "${WORK}/sources" \
    && ok 'the pasted source is back, by title' \
    || bad 'the pasted source is back, by title'

  grep -qF 'rehearsal-requirements.txt' "${WORK}/sources" \
    && ok 'the uploaded source is back, by filename' \
    || bad 'the uploaded source is back, by filename'
else
  bad 'the restored session can list its sources' "HTTP ${status}"
fi

# The check that matters most: the bytes the application serves back are the bytes that
# went in. A database restored without its files, or files restored under identifiers
# the database no longer uses, both fail here and nowhere else.
if [[ -n "${SOURCE_ID}" ]]; then
  status="$(call "${WORK}/downloaded" GET \
    "${API}/api/v1/projects/current/sources/${SOURCE_ID}/download" \
    --cookie "${WORK}/jar-restored")"

  if [[ "${status}" == '200' ]]; then
    DOWNLOAD_SHA="$(sha256sum "${WORK}/downloaded" | cut -d' ' -f1)"

    if [[ "${DOWNLOAD_SHA}" == "${UPLOAD_SHA}" ]]; then
      ok "the uploaded file downloads byte-for-byte identical (sha256 ${UPLOAD_SHA:0:16}…)"
    else
      bad 'the uploaded file downloads byte-for-byte identical' \
        "uploaded ${UPLOAD_SHA}, downloaded ${DOWNLOAD_SHA}"
    fi
  else
    bad 'the uploaded file can be downloaded after the restore' "HTTP ${status}"
  fi
fi

# --------------------------------------------------------------------------- result

printf '\n'

if (( failures > 0 )); then
  printf 'Rehearsal FAILED: %d check(s) did not pass.\n' "${failures}"
  exit 1
fi

printf 'Rehearsal passed. Backup taken, data destroyed, data recovered, bytes verified.\n'
exit 0
