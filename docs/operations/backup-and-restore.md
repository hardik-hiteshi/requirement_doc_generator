# Backup and restore

Nobody else is taking these. There is no vendor, no managed database and no support
channel that can recover a project — the recovery link cannot restore what is not there.

This page has three parts: what to back up, how to restore it, and **the recorded result
of a restore that was actually performed**. The third part is the one that matters. A
backup procedure nobody has restored from is a hypothesis.

## What holds state

Two things, and only two:

| What           | Where                                   | Losing it means                                              |
| -------------- | --------------------------------------- | ------------------------------------------------------------ |
| MongoDB        | `MONGODB_URI`                           | Every project, extraction, document, version and audit event |
| Uploaded files | `UPLOAD_STORAGE_ROOT`, or the S3 bucket | The original client documents                                |

Everything else is derived or configured. Images rebuild from a tag, secrets come from
your secret store, and the metrics registry is per process by design. A backup that
included them would be larger, no more useful, and a place for a secret to end up.

**Both halves or neither.** A database restored without its files leaves every uploaded
source pointing at bytes that are not there — the project opens, the source list looks
right, and every download fails. Files restored without the database are unreferenced and
unretained. Take them together, at the same time.

## Taking a backup

```bash
infrastructure/scripts/backup.sh \
  --uri mongodb://mongodb:27017/wdrg \
  --network wdrg-prod_default \
  --uploads-volume wdrg-prod-uploads-data \
  --output-dir /var/backups/wdrg \
  --label nightly
```

It produces a timestamped directory containing a gzipped `mongodump` archive, a tar of
the storage root, a `manifest.json` recording what was taken and from where, and
`SHA256SUMS`.

`mongodump` and the file copy both run inside the `mongo` image the deployment already
runs, so the **host needs Docker and nothing else** — no MongoDB tools, no version-matched
client. A restore host provisioned in a hurry has Docker; it does not reliably have
`mongodump` of the right major version.

The URI must name a database. A dump of "everything" would include `admin` and `local`,
which a restore must never overwrite.

### With object storage instead of a volume

`--uploads-volume` handles the filesystem adapter. With `STORAGE_ADAPTER=s3` the bucket is
mirrored separately, with the client that ships in the same MinIO image family:

```bash
docker run --rm --network wdrg-prod_default \
  --volume /var/backups/wdrg:/backup \
  --entrypoint /bin/sh minio/mc:RELEASE.2025-04-16T18-13-26Z -c '
    mc alias set src http://minio:9000 "$ACCESS" "$SECRET" &&
    mc mirror --overwrite src/wdrg-requirements /backup/objects
  '
```

Run it in the same window as the database dump. `backup.sh` says out loud when no uploads
volume was named, so a deployment cannot quietly end up with database-only backups.

### Encryption is your job, deliberately

The archive contains **client documents and the requirement text extracted from them**. It
is written mode 600, and the whole point of this architecture is that requirement content
stays on infrastructure you own — an unencrypted archive on a laptop or an object store
somebody forgot to lock down is the most common way that stops being true.

`backup.sh` does not encrypt it. Choosing and managing a key belongs to the deployment,
and a script that invented one would give a false sense of having solved it:

```bash
age -r age1... -o backup.tar.gz.age <(tar cf - "${BACKUP_DIR}")
```

### Scheduling

A cron entry on the host, or a scheduled job in whatever runs your containers. Nothing in
the application schedules this — a backup the application controls is a backup that stops
when the application does.

```cron
# Nightly at 02:15, keeping 14 days.
15 2 * * * /opt/wdrg/infrastructure/scripts/backup.sh --uri "$MONGODB_URI" --network wdrg-prod_default --uploads-volume wdrg-prod-uploads-data --output-dir /var/backups/wdrg --label nightly >> /var/log/wdrg-backup.log 2>&1
20 4 * * * find /var/backups/wdrg -maxdepth 1 -mindepth 1 -type d -mtime +14 -exec rm -rf {} +
```

## Restoring

```bash
infrastructure/scripts/restore.sh \
  --from /var/backups/wdrg/20260817T021500Z-nightly \
  --uri mongodb://mongodb:27017/wdrg \
  --network wdrg-prod_default \
  --uploads-volume wdrg-prod-uploads-data
```

Stop the API first. Restoring underneath a running process is not what a real recovery
looks like, and an in-flight write during the drop muddies what you end up with.

What it does before touching anything:

- **Verifies `SHA256SUMS`.** A truncated transfer produces an archive `mongorestore` reads
  most of, and a partial restore that reports success is worse than a failed one. A backup
  with no checksum file is refused outright.
- **Refuses to restore over a database that already has projects in it**, without
  `--force`. The scenario this guards is the one that actually happens: somebody restores
  last week's backup onto the live deployment to "check something", and `--drop` removes a
  week of work that was never backed up.
- **Confines the write with `--nsInclude`**, so an archive cannot reach `admin` or `local`
  however it was produced.

To inspect a backup without touching the live database, restore it into a different name:
`--uri mongodb://mongodb:27017/wdrg_inspect`. The script notices the mismatch with the
manifest and says so rather than refusing, because that is a legitimate thing to do.

### Restoring is a replacement, not a merge

`--drop` removes each collection in the archive before writing it, and the upload volume
is emptied before extraction. Without that, documents deleted since the backup would come
back and documents changed since would silently win — which is not "restored", it is a
third state that matches neither.

## The rehearsal

`infrastructure/scripts/restore-rehearsal.sh` runs the whole thing unattended against a
throwaway deployment: it starts the API image, creates real data through the real
ingestion path, backs it up, **destroys it**, proves the destruction was real, restores,
and then verifies through the API — including downloading the uploaded file back and
comparing its sha256 with what went in.

That last check is the point. Row counts prove a restore wrote something; a checksum of
the file the application serves back proves the two halves of the backup still refer to
each other.

It runs in CI on every push, and it refuses to run against a database whose name does not
contain `rehearsal`, because step four drops a database.

### Recorded result

Executed locally on 2026-08-17 against the `wdrg-api:local` image, the compose stack's
MongoDB 8.0 and ClamAV 1.4. Condensed only by removing the two scripts' own paths and
progress lines — every check is here as it printed:

```text
Restore rehearsal
  network:  wdrg-dev_default
  database: wdrg_restore_rehearsal
  image:    wdrg-api:local

=== 1. Starting the API image against a throwaway database
  ok    the API image is running and reports ready

=== 2. Creating data worth losing
  ok    project prj_1Q3Q7F4K7XZA572AD2CPMWCRMB created
  ok    a pasted requirement source was added
  ok    a file was uploaded, scanned and stored
  recorded state: 2 source(s) in the database, 1 file(s) in the storage root
  ok    both sources are in the database (2)
  ok    the upload really is on the volume

=== 3. Taking a backup
Dumping MongoDB...
  4.0K mongodb.archive.gz
Archiving uploaded files from volume wdrg-rehearsal-uploads...
  4.0K uploads.tar.gz
  ok    backup.sh completed
  ok    the archive verifies against its own checksums

=== 4. Destroying the data
  ok    the database is empty
  ok    the storage root is empty
  ok    the project is unreachable through the API (HTTP 401)

=== 5. Restoring
Verifying checksums...
./mongodb.archive.gz: OK
./uploads.tar.gz: OK
Inspecting the target...
  wdrg_restore_rehearsal already holds 0 project(s).
Restoring MongoDB...
  wdrg_restore_rehearsal now holds 1 project(s).
Restoring uploaded files into volume wdrg-rehearsal-uploads...
  1 file(s) in the storage root.
  ok    restore.sh completed

=== 6. Verifying the restore through the API
  ok    source count matches (2)
  ok    the recovery secret opens the restored project
  ok    the pasted source is back, by title
  ok    the uploaded source is back, by filename
  ok    the uploaded file downloads byte-for-byte identical (sha256 c891c6cb6a958adf…)

Rehearsal passed. Backup taken, data destroyed, data recovered, bytes verified.
```

**What the first version of this rehearsal got wrong**, because it is worth recording: it
counted a collection named `requirementsources` rather than `requirement_sources`, so
"before" and "after" were both zero and the comparison passed while proving nothing. The
script now asserts the recorded count is at least two before it is ever compared. An
assertion that two numbers are equal is only worth something if one of them is known not
to be zero.

## What a restore does not bring back

- **Sessions.** They are stateless signed cookies. After a restore, a session issued
  before it still verifies if the secret is unchanged — but the project it names must
  exist, so a session for a project not in the backup fails cleanly rather than
  half-working.
- **In-flight extraction.** A job claimed when the backup was taken is restored as
  claimed. It is reclaimed after `EXTRACTION_CLAIM_TIMEOUT_MS`; until then
  `GET /admin/queue` reports it as stalled.
- **Anything created after the backup.** Which is the reason to know how old your most
  recent one is. `manifest.json` records `createdAt`.

## Related

- [Deployment](deployment.md)
- [Retention](retention.md) — what gets deleted on purpose, and when
- [Schema changes](schema-changes.md) — restoring across a schema change
