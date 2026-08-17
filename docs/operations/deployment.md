# Deployment

How to run this application somewhere real, and what it refuses to do if you get it
wrong.

Two images, four dependencies, one secret you must generate. Everything here runs on
hardware you control; nothing in it requires an account with anybody.

## The two images

| Image      | Built from                             | Runs                      | Deployment-agnostic |
| ---------- | -------------------------------------- | ------------------------- | ------------------- |
| `wdrg-api` | `infrastructure/docker/api.Dockerfile` | `node dist/main.js`       | Yes                 |
| `wdrg-web` | `infrastructure/docker/web.Dockerfile` | `node apps/web/server.js` | **No** — see below  |

Both are multi-stage: the shipped layer holds compiled output and production
dependencies, not the toolchain that produced them. Both pin their base by digest, run
as the non-root `node` user, declare a healthcheck, and have had npm, npx, corepack and
yarn deleted — the application installs nothing at runtime, and a production container
that can fetch and execute new code is capability without purpose. `verify-image.sh`
asserts every one of those properties against the built artefact.

### The web image is built for one API origin

`NEXT_PUBLIC_API_BASE_URL` is **inlined into the client bundle at build time**. It is not
read when the container starts, so an image built for one deployment cannot be pointed at
another API by setting a variable — the browser would keep calling the old host. This is
how Next.js handles `NEXT_PUBLIC_*`, not a choice made here, and it is the single most
likely way a deployment of this image goes wrong.

So the build fails without it:

```bash
docker build -f infrastructure/docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://requirements-api.example.internal \
  -t wdrg-web:1.0.0 .
```

A build that forgot the argument would otherwise produce a bundle calling a relative
path, which fails in a way nobody diagnoses quickly.

**Consequence for the published image.** The `wdrg-web` image in the registry is built
with the origin configured in this repository's CI (`WEB_API_BASE_URL`, defaulting to a
localhost origin, which is useful only for local evaluation). Unless that variable names
_your_ API, build your own web image — it is the one command above. The `wdrg-api` image
has no such property and is deployable as published.

The smoke test checks this: it greps the served bundle for the origin it was told to
expect, and fails if the image was built for a different one.

## Configuration

Every setting is in [`.env.example`](../../.env.example) with its default and its
consequence. The ones a deployment must decide:

| Setting                  | Why it matters                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `PROJECT_SESSION_SECRET` | At least 32 random characters. The development placeholder is refused                              |
| `MONGODB_URI`            | Include the database name; the backup scripts read it from here                                    |
| `STORAGE_ADAPTER`        | `s3` for object storage, `filesystem` for an absolute path on a backed-up disk                     |
| `MALWARE_SCANNER`        | `clamav`, or `reject` to refuse all uploads. `none` is refused in production                       |
| `AI_PROVIDER`            | `disabled`, or an inference server you run — see [self-hosted inference](self-hosted-inference.md) |
| `ADMIN_API_TOKEN`        | Empty means the operator surface does not exist. See [operator surface](operator-surface.md)       |
| `RETENTION_ENABLED`      | Off keeps expired and deleted content for ever. Lawful, but say so deliberately                    |

### Production refuses to start when it is configured unsafely

Checked once at bootstrap, before anything listens, and every problem is reported
together. The full list is in
[self-hosting](self-hosting.md#configuration-and-what-production-refuses); the ones that
most often surprise a first deployment:

- **`S3_USE_SSL=false` with an endpoint that is not on this host.** Object storage
  credentials and client documents crossing a network in the clear. Terminate TLS in
  front of MinIO, or use the filesystem adapter on a backed-up volume.
- **A relative `UPLOAD_STORAGE_ROOT`.** It resolves against the working directory, so the
  same deployment started from elsewhere writes somewhere else and silently cannot find
  yesterday's files.
- **`AI_PROVIDER=deterministic`.** Returns fixtures. It would produce a requirement
  baseline made of nothing, presented exactly as confidently as a real one.

A misconfiguration that boots successfully is the dangerous kind: nothing looks wrong
until an unscanned file has been accepted.

## Running it

### With compose, for evaluation and for verifying the images

The compose stack starts dependencies by default and the application behind a profile:

```bash
PROJECT_SESSION_SECRET=$(openssl rand -hex 24) \
  bash infrastructure/scripts/compose.sh --profile app up --build -d
```

The app profile uses `STORAGE_ADAPTER=filesystem` on a named volume, deliberately: the
production policy refuses a plain-HTTP S3 endpoint that is not on this host, and MinIO on
the compose network is exactly that. Weakening the check to make a demo start would be
the wrong trade, so the stack uses the other supported production configuration instead.

`--profile app` also rebuilds, which is the only honest test that the Dockerfiles work: a
build that succeeds and a container that cannot reach its database are different
failures, and only the second one matters in production.

### Without compose

The API needs MongoDB, and — where configured — object storage and ClamAV. Nothing else.
It is a modular monolith with in-process workers, so there is no separate worker
deployment, no message broker and no scheduler to run.

```bash
docker run -d --name wdrg-api \
  --publish 127.0.0.1:3001:3001 \
  --volume wdrg-uploads:/var/lib/wdrg/uploads \
  --env NODE_ENV=production \
  --env MONGODB_URI=mongodb://mongo.internal:27017/wdrg \
  --env PROJECT_SESSION_SECRET="${SESSION_SECRET}" \
  --env STORAGE_ADAPTER=filesystem \
  --env MALWARE_SCANNER=clamav --env CLAMAV_HOST=clamav.internal \
  --env API_PUBLIC_URL=https://requirements-api.example.internal \
  --env WEB_PUBLIC_URL=https://requirements.example.internal \
  ghcr.io/<owner>/wdrg-api:sha-<commit>
```

`WEB_PUBLIC_URL` is the CORS allow-list, not decoration: the browser sends the session
cookie cross-origin, so a wrong value makes every request from the web application fail
with no server-side error to look at.

### What to run more than one of

The API is horizontally scalable with one caveat worth knowing: **the rate limiter is
in-process**. Behind _n_ instances each caller effectively gets _n_ times the ceiling. The
trade and the alternative are in [rate limiting](rate-limiting.md). Everything else —
sessions, extraction claims, retention — coordinates through MongoDB and is safe to run
in parallel.

## Probes

| Endpoint            | Answers                                                  | Use for             |
| ------------------- | -------------------------------------------------------- | ------------------- |
| `/api/health/live`  | The process is running. Checks no dependency             | Restart policy      |
| `/api/health/ready` | MongoDB reachable, heap inside its threshold, scanner up | Traffic and rollout |

Both are version-neutral on purpose: a probe must not need reconfiguring when the
business API moves to v2. Point the orchestrator's readiness gate at `/ready` and its
liveness gate at `/live` — the other way round restarts a healthy instance during a
database blip.

The image's own `HEALTHCHECK` polls readiness with a 40-second start period, which is
what a cold Mongoose connection plus index builds need.

## Shutdown

The container starts `node` as PID 1 with no shell or init wrapper, so `SIGTERM` reaches
the process and `enableShutdownHooks()` runs: in-flight requests finish, the extraction
and retention workers stop, and the MongoDB connection closes. Give it a termination
grace period of at least 30 seconds. A `SIGKILL` mid-extraction is survivable — a claimed
job is reclaimed after `EXTRACTION_CLAIM_TIMEOUT_MS` and `GET /admin/queue` reports it as
stalled meanwhile — but it costs a user their upload's progress.

## Legacy `.doc` and `.xls`

Conversion goes through LibreOffice, which is **not in the image**: it is off by default
and adds several hundred megabytes. A deployment that needs it adds it to a derived
image:

```dockerfile
FROM ghcr.io/<owner>/wdrg-api:sha-<commit>
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc \
    && rm -rf /var/lib/apt/lists/*
USER node
```

Shipping half a gigabyte for a disabled feature is the wrong default; hiding that the
choice was made would be worse.

## Verifying a deployment

After every release, against the deployment itself:

```bash
infrastructure/scripts/smoke-test.sh \
  --api https://requirements-api.example.internal \
  --web https://requirements.example.internal \
  --production \
  --expect-version 0.1.0
```

Fifty-one checks over HTTP: readiness with its named indicators, the security headers,
the error envelope with no stack trace in it, correlation id propagation both ways, the
operator surface absent when unconfigured, and a full authenticated flow — create a
project, refuse a write with no CSRF token, add a source, read it back, exchange the
recovery secret from a fresh cookie jar, prove one session cannot see another's project,
refuse a mutation carrying a mismatched version, and delete what it created.

It needs only `curl` and a shell, because it is the script somebody runs from a jump host
five minutes after a release. It **does write to the deployment** — one project, deleted
at the end — because a read-only smoke test would pass against a deployment whose writes
all fail.

Add `--admin-token` to check the token boundary instead of the surface's absence — the
same run, fifty-six checks. On a deployment that has a token configured, leaving the flag
off is a **failure**, not a skip: the absence check is a real assertion, and it is
correctly false there.

## What is deliberately not here

**No Kubernetes manifests, no Helm chart, no Terraform.** Two stateless containers and a
database is not a distributed system, and a chart would encode opinions about ingress,
storage classes and secret management that belong to the deployment rather than to this
repository. The images and the probes are what an orchestrator needs; the rest is yours.

**No TLS termination.** The API sets HSTS and expects to sit behind something that
terminates TLS. Doing it in-process would mean managing certificates in the application.

**No log shipping.** Logs are structured JSON on stdout with redaction already applied.
Where they go is a deployment decision.

## Related

- [Backup and restore](backup-and-restore.md) — including a rehearsal that was actually run
- [Releases](releases.md) — versions, tags and what gets published
- [Observability](observability.md) — metrics, and the example alert rules
- [Operator surface](operator-surface.md) — the token, and what it opens
- [Self-hosting](self-hosting.md) — what runs, what it costs, and the trade being made
