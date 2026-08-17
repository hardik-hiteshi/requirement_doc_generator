#!/usr/bin/env bash
# Takes a backup of everything a deployment cannot reconstruct.
#
# Two things, and only two, hold state that matters:
#
#   1. **MongoDB** — projects, requirement sources, extracted content, documents,
#      versions, the audit trail.
#   2. **Uploaded files** — the original client documents, in whichever store the
#      deployment configured.
#
# Everything else is derived or configured: images are rebuilt from a tag, secrets come
# from the deployment's own secret store, and the metrics registry is per process by
# design. A backup that included them would be larger, no more useful, and a place for
# a secret to end up.
#
# ## What is in the archive, and why it needs protecting
#
# **Client documents and the requirement text extracted from them.** The whole point of
# this system is that requirement content stays on infrastructure the operator owns —
# and an unencrypted backup on a laptop or an object store somebody forgot to lock down
# is the most common way that stops being true. The archive is written mode 600 and the
# procedure in docs/operations/backup-and-restore.md says to encrypt it before it
# leaves the host. This script deliberately does not encrypt it itself: choosing and
# managing the key belongs to the deployment, and a script that invented one would give
# a false sense of having solved it.
#
# ## Why it shells out to containers
#
# `mongodump` runs in the same `mongo` image the deployment already runs, and the file
# copy runs in that image too. So the host needs Docker and nothing else — no MongoDB
# tools, no version-matched client, no Python. A restore host provisioned in a hurry
# has Docker; it does not reliably have `mongodump` of the right major version.
#
# ## Usage
#
#   infrastructure/scripts/backup.sh \
#     --uri mongodb://mongodb:27017/wdrg \
#     --network wdrg-dev_default \
#     [--uploads-volume wdrg-dev-uploads-data] \
#     [--output-dir ./backups] \
#     [--label pre-upgrade]
#
# Produces <output-dir>/<timestamp><-label>/ containing:
#
#   mongodb.archive.gz   a gzipped mongodump archive of the one database
#   uploads.tar.gz       the upload storage root, if a volume was named
#   manifest.json        what was taken, from where, and its checksums
#   SHA256SUMS           checksums in the format `sha256sum -c` reads
set -euo pipefail

MONGO_IMAGE='mongo:8.0'
URI=''
NETWORK=''
UPLOADS_VOLUME=''
OUTPUT_DIR='./backups'
LABEL=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uri) URI="${2:?--uri needs a MongoDB connection string}"; shift 2 ;;
    --network) NETWORK="${2:?--network needs a Docker network}"; shift 2 ;;
    --uploads-volume) UPLOADS_VOLUME="${2:?--uploads-volume needs a volume name}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:?--output-dir needs a path}"; shift 2 ;;
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --mongo-image) MONGO_IMAGE="${2:?--mongo-image needs a reference}"; shift 2 ;;
    -h|--help) sed -n '2,46p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "${URI}" ]] || { echo '--uri is required.' >&2; exit 2; }
command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 2; }

# The database name is the last path segment, minus any query string. Needed because
# the manifest records it and because a restore must know what it is restoring into.
DATABASE="${URI##*/}"
DATABASE="${DATABASE%%\?*}"

[[ -n "${DATABASE}" ]] || {
  echo "The URI names no database: ${URI}" >&2
  echo 'Include one, e.g. mongodb://mongodb:27017/wdrg — a dump of "everything" would' >&2
  echo 'include the admin and local databases, which a restore must never overwrite.' >&2
  exit 2
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DESTINATION="${OUTPUT_DIR%/}/${STAMP}${LABEL:+-${LABEL}}"

mkdir -p "${DESTINATION}"
# Nobody but the owner. The contents are client documents.
chmod 700 "${DESTINATION}"

ABSOLUTE="$(cd "${DESTINATION}" && pwd)"

network_args=()
[[ -n "${NETWORK}" ]] && network_args=(--network "${NETWORK}")

# --user: files land owned by the invoking user rather than root, so a later `rm` or
# `tar` on the host does not need privileges it should not need.
run_helper() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    "${network_args[@]}" \
    "$@"
}

# The upload volume is owned by the uid the API runs as, which is not the uid running
# this script. Reading it needs root in the container — and the archive it produces is
# handed back to the invoking user immediately, so nothing root-owned is left behind.
run_root() {
  docker run --rm "$@"
}

printf 'Backing up %s\n  database: %s\n  into:     %s\n' "${URI%%\?*}" "${DATABASE}" "${ABSOLUTE}"

# ------------------------------------------------------------------------ mongodb
#
# A single archive rather than a directory of BSON files: one file to checksum, one
# file to encrypt, one file to move. `--gzip` because requirement text and audit
# metadata compress by roughly an order of magnitude.

printf '\nDumping MongoDB...\n'

run_helper \
  --volume "${ABSOLUTE}:/backup" \
  "${MONGO_IMAGE}" \
  mongodump --uri="${URI}" --archive=/backup/mongodb.archive.gz --gzip --quiet

[[ -s "${ABSOLUTE}/mongodb.archive.gz" ]] || {
  echo 'The dump produced no data. Refusing to record an empty backup as a good one.' >&2
  exit 1
}

printf '  %s\n' "$(du -h "${ABSOLUTE}/mongodb.archive.gz" | cut -f1) mongodb.archive.gz"

# ------------------------------------------------------------------------ uploads

uploads_note='not backed up (no --uploads-volume given)'

if [[ -n "${UPLOADS_VOLUME}" ]]; then
  printf '\nArchiving uploaded files from volume %s...\n' "${UPLOADS_VOLUME}"

  # Read-only mount: a backup must not be able to modify what it is reading. Ownership
  # inside the archive is preserved, so a restore puts the files back owned by the uid
  # the API runs as rather than by whoever happened to run the restore.
  run_root \
    --volume "${UPLOADS_VOLUME}:/uploads:ro" \
    --volume "${ABSOLUTE}:/backup" \
    "${MONGO_IMAGE}" \
    sh -c "tar czf /backup/uploads.tar.gz -C /uploads . && chown $(id -u):$(id -g) /backup/uploads.tar.gz"

  uploads_note="volume ${UPLOADS_VOLUME}"
  printf '  %s\n' "$(du -h "${ABSOLUTE}/uploads.tar.gz" | cut -f1) uploads.tar.gz"
else
  # Said out loud, because a deployment using object storage backs it up with its
  # own tooling and one using the filesystem adapter has just been told its client
  # documents are not in this archive.
  printf '\nNo uploads volume named.\n'
  printf '  With STORAGE_ADAPTER=filesystem, pass --uploads-volume or the client files\n'
  printf '  are not in this backup. With s3, mirror the bucket separately — see\n'
  printf '  docs/operations/backup-and-restore.md.\n'
fi

# ----------------------------------------------------------------------- manifest

printf '\nWriting the manifest...\n'

# Checksums first: the manifest records them, and `SHA256SUMS` is what a restore
# verifies against. A backup nobody can prove is intact is a backup nobody should
# restore from.
(cd "${ABSOLUTE}" && sha256sum ./*.gz > SHA256SUMS)

archive_sum="$(awk '/mongodb.archive.gz$/ {print $1}' "${ABSOLUTE}/SHA256SUMS")"
uploads_sum="$(awk '/uploads.tar.gz$/ {print $1}' "${ABSOLUTE}/SHA256SUMS")"

cat > "${ABSOLUTE}/manifest.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "${DATABASE}",
  "mongoImage": "${MONGO_IMAGE}",
  "uploads": "${uploads_note}",
  "label": "${LABEL}",
  "files": {
    "mongodb.archive.gz": "${archive_sum}"$([[ -n "${uploads_sum}" ]] && printf ',\n    "uploads.tar.gz": "%s"' "${uploads_sum}")
  }
}
JSON

chmod 600 "${ABSOLUTE}"/* 2>/dev/null || true

printf '\nBackup complete: %s\n' "${ABSOLUTE}"
printf 'Verify with:  cd %s && sha256sum -c SHA256SUMS\n' "${ABSOLUTE}"
printf 'Restore with: infrastructure/scripts/restore.sh --from %s --uri <uri> ...\n' "${ABSOLUTE}"
printf '\nThis archive contains client documents. Encrypt it before it leaves this host.\n'
