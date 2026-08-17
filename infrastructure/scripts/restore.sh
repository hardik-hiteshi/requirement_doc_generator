#!/usr/bin/env bash
# Restores a backup taken by backup.sh.
#
# The counterpart, and the half that actually matters: a backup procedure nobody has
# restored from is a hypothesis. `restore-rehearsal.sh` runs this script against a
# throwaway deployment and proves it, and the recorded result of that rehearsal is in
# docs/operations/backup-and-restore.md.
#
# ## What it refuses to do
#
# **Restore over a database that already has projects in it**, without `--force`. The
# scenario this guards is the one that actually happens: somebody restores last week's
# backup onto the live deployment to "check something", and `--drop` removes a week of
# work that was never backed up. So the default is to refuse and say what it found.
#
# **Restore into a database the URI does not name.** The dump is a single-database
# archive; the target is named explicitly and `--nsInclude` confines the restore to it,
# so a mistyped URI cannot write into `admin` or `local`.
#
# ## What it does before touching anything
#
# Verifies `SHA256SUMS`. A truncated transfer produces an archive `mongorestore` reads
# most of, and a partial restore that reports success is worse than a failed one.
#
# ## Usage
#
#   infrastructure/scripts/restore.sh \
#     --from ./backups/20260817T120000Z \
#     --uri mongodb://mongodb:27017/wdrg \
#     --network wdrg-dev_default \
#     [--uploads-volume wdrg-dev-uploads-data] \
#     [--force]
set -euo pipefail

MONGO_IMAGE='mongo:8.0'
FROM=''
URI=''
NETWORK=''
UPLOADS_VOLUME=''
FORCE='false'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?--from needs a backup directory}"; shift 2 ;;
    --uri) URI="${2:?--uri needs a MongoDB connection string}"; shift 2 ;;
    --network) NETWORK="${2:?--network needs a Docker network}"; shift 2 ;;
    --uploads-volume) UPLOADS_VOLUME="${2:?--uploads-volume needs a volume name}"; shift 2 ;;
    --mongo-image) MONGO_IMAGE="${2:?--mongo-image needs a reference}"; shift 2 ;;
    --force) FORCE='true'; shift ;;
    -h|--help) sed -n '2,34p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "${FROM}" ]] || { echo '--from is required.' >&2; exit 2; }
[[ -n "${URI}" ]] || { echo '--uri is required.' >&2; exit 2; }
[[ -d "${FROM}" ]] || { echo "No such backup directory: ${FROM}" >&2; exit 2; }
command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 2; }

ABSOLUTE="$(cd "${FROM}" && pwd)"

DATABASE="${URI##*/}"
DATABASE="${DATABASE%%\?*}"

[[ -n "${DATABASE}" ]] || { echo "The URI names no database: ${URI}" >&2; exit 2; }

network_args=()
[[ -n "${NETWORK}" ]] && network_args=(--network "${NETWORK}")

run_helper() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    "${network_args[@]}" \
    "$@"
}

# Writing into the upload volume needs root in the container: the volume is owned by
# the uid the API runs as, and the archive records that ownership, so extracting as
# root is what puts the files back readable by the application.
run_root() {
  docker run --rm "$@"
}

# `mongosh --eval` in the same image, so this needs no local client either.
mongo_eval() {
  run_helper "${MONGO_IMAGE}" mongosh "${URI}" --quiet --eval "$1"
}

printf 'Restoring %s\n  from:     %s\n  database: %s\n' "${URI%%\?*}" "${ABSOLUTE}" "${DATABASE}"

# ------------------------------------------------------------------- verification

printf '\nVerifying checksums...\n'

if [[ -f "${ABSOLUTE}/SHA256SUMS" ]]; then
  (cd "${ABSOLUTE}" && sha256sum -c SHA256SUMS) || {
    echo 'Checksum verification failed. Refusing to restore a damaged backup.' >&2
    exit 1
  }
else
  echo 'No SHA256SUMS in this backup. Refusing: an unverifiable archive may be partial.' >&2
  exit 1
fi

[[ -f "${ABSOLUTE}/mongodb.archive.gz" ]] || {
  echo 'No mongodb.archive.gz in this backup.' >&2
  exit 1
}

if [[ -f "${ABSOLUTE}/manifest.json" ]]; then
  recorded="$(sed -n 's/.*"database": "\([^"]*\)".*/\1/p' "${ABSOLUTE}/manifest.json")"

  if [[ -n "${recorded}" && "${recorded}" != "${DATABASE}" ]]; then
    # Not fatal — restoring into a differently-named database is a legitimate way to
    # inspect a backup without touching the live one — but it is worth saying, because
    # the accidental version of this is a typo.
    printf '\nNote: this backup was taken from "%s" and is being restored into "%s".\n' \
      "${recorded}" "${DATABASE}"
  fi
fi

# ------------------------------------------------------------------ the safety gate

printf '\nInspecting the target...\n'

existing="$(mongo_eval 'db.projects.countDocuments({})' 2>/dev/null | tr -dc '0-9')"
existing="${existing:-0}"

printf '  %s already holds %s project(s).\n' "${DATABASE}" "${existing}"

if [[ "${existing}" != '0' && "${FORCE}" != 'true' ]]; then
  cat >&2 <<MESSAGE

Refusing to restore over a database that already has projects in it.

  A restore drops each collection in the archive before writing it, so anything in
  ${DATABASE} that is not in this backup would be gone — including work done since
  the backup was taken.

  If that is genuinely what you want, re-run with --force. If you are trying to
  inspect a backup, restore it into a different database name instead:

    --uri ${URI%/*}/${DATABASE}_inspect
MESSAGE
  exit 1
fi

# ------------------------------------------------------------------------ mongodb
#
# `--drop` removes each collection the archive contains before restoring it, so a
# restore is a replacement rather than a merge. Without it, documents deleted since the
# backup would come back and documents changed since would silently win — which is not
# "restored", it is a third state that matches neither.
#
# `--nsInclude` confines the write to the named database, so an archive cannot reach
# `admin` or `local` however it was produced.

printf '\nRestoring MongoDB...\n'

run_helper \
  --volume "${ABSOLUTE}:/backup:ro" \
  "${MONGO_IMAGE}" \
  mongorestore --uri="${URI}" \
    --archive=/backup/mongodb.archive.gz --gzip \
    --drop \
    --nsInclude="${DATABASE}.*" \
    --quiet

restored="$(mongo_eval 'db.projects.countDocuments({})' 2>/dev/null | tr -dc '0-9')"
printf '  %s now holds %s project(s).\n' "${DATABASE}" "${restored:-0}"

# ------------------------------------------------------------------------ uploads

if [[ -n "${UPLOADS_VOLUME}" ]]; then
  if [[ -f "${ABSOLUTE}/uploads.tar.gz" ]]; then
    printf '\nRestoring uploaded files into volume %s...\n' "${UPLOADS_VOLUME}"

    # Cleared first, for the same reason mongorestore uses --drop: a merge would leave
    # files belonging to projects the restored database has never heard of, which then
    # sit there unreferenced and unretained for ever.
    run_root \
      --volume "${UPLOADS_VOLUME}:/uploads" \
      --volume "${ABSOLUTE}:/backup:ro" \
      "${MONGO_IMAGE}" \
      sh -c 'rm -rf /uploads/* /uploads/.[!.]* 2>/dev/null; tar xzf /backup/uploads.tar.gz -C /uploads'

    count="$(run_root --volume "${UPLOADS_VOLUME}:/uploads:ro" "${MONGO_IMAGE}" \
      sh -c 'find /uploads -type f | wc -l' | tr -dc '0-9')"
    printf '  %s file(s) in the storage root.\n' "${count:-0}"
  else
    echo 'No uploads.tar.gz in this backup, but --uploads-volume was given.' >&2
    echo 'The database will reference files that are not there. Stopping.' >&2
    exit 1
  fi
fi

printf '\nRestore complete.\n'
printf 'The API caches nothing across a restore, but restart it anyway so an in-flight\n'
printf 'request cannot be holding a session for a project that has just been replaced.\n'
