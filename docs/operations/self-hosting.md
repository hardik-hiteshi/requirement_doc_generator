# Self-hosting

> The core application is designed to operate using self-hosted open-source
> components. No paid third-party API or managed SaaS service is required for
> requirement ingestion, OCR, storage, malware scanning, AI processing,
> estimation, document generation, or export.

That is a statement about **vendor dependency**, not about cost. Running this
application is not free — see [what it actually costs](#what-this-actually-costs).

## What runs, and where

Every component is open-source and runs on hardware you control.

| Concern              | Component                             | Licence          | Required                 |
| -------------------- | ------------------------------------- | ---------------- | ------------------------ |
| Database             | MongoDB Community                     | SSPL-1.0         | Always                   |
| Object storage       | MinIO, or the local filesystem        | AGPL-3.0 / —     | One of the two           |
| Malware scanning     | ClamAV                                | GPL-2.0          | Production               |
| Text recognition     | Tesseract                             | Apache-2.0       | For images and scans     |
| Legacy `.doc`/`.xls` | LibreOffice                           | MPL-2.0          | Optional, off by default |
| Background work      | A MongoDB collection                  | —                | Always                   |
| AI inference         | Ollama or an OpenAI-compatible server | MIT / Apache-2.0 | For analysis             |

Nothing above calls a vendor API. The full picture, including licence
obligations, is in the
[dependency and service inventory](../architecture/dependency-and-service-inventory.md).

## Starting the whole stack

One command, from a clean checkout:

```bash
pnpm install
pnpm docker:up          # MongoDB, MinIO, bucket initialisation, ClamAV
pnpm docker:wait:all    # blocks until all three answer
```

ClamAV is the slow one. It loads roughly a gigabyte of signatures before it will
accept a connection, so a cold start takes a couple of minutes; `docker:wait:all`
budgets for that. `minio-init` runs once, creates a **private** bucket, and
exits — seeing it stopped in `docker compose ps` is the success case.

Removing it all:

```bash
pnpm docker:down          # containers only; your data volumes survive
pnpm docker:down -- -v    # volumes too — deliberate, and irreversible
```

Volumes are namespaced by `COMPOSE_PROJECT_NAME`, so a throwaway verification
stack cannot collide with, or destroy, the data you are working against.

That starts the **dependencies** only, because running the applications with
`pnpm dev` keeps the edit-reload loop fast. To run the application itself from the
images that ship:

```bash
PROJECT_SESSION_SECRET=$(openssl rand -hex 24) \
  bash infrastructure/scripts/compose.sh --profile app up --build -d
```

The API and web services live behind the `app` profile, so nothing about the
default behaviour changed when they were added. See
[deployment](deployment.md).

Every host port is configurable (`MONGODB_HOST_PORT`, `MINIO_HOST_PORT`,
`CLAMAV_HOST_PORT`, …) and every service binds to `127.0.0.1`. A development
database, object store or virus scanner reachable from the network is a
liability, not a convenience.

## Configuration, and what production refuses

The application checks its own configuration at startup and **refuses to run** a
production deployment that is unsafe. It reports every problem at once, each with
a fix. The rules:

| Setting                  | Production rule                                                              |
| ------------------------ | ---------------------------------------------------------------------------- |
| `MALWARE_SCANNER`        | `none` is rejected. Use `clamav`, or `reject` to refuse all uploads          |
| `STORAGE_ADAPTER`        | `filesystem` is flagged — it ties uploaded documents to one machine's disk   |
| `S3_*`                   | With `STORAGE_ADAPTER=s3`, endpoint, bucket and both credentials must be set |
| `S3_USE_SSL`             | Must be on unless the storage server is on the same host                     |
| `PROJECT_SESSION_SECRET` | The development placeholder is rejected                                      |
| `AI_BASE_URL`            | Must be set if a provider is selected — and must point at your own server    |

This is deliberate. A misconfiguration that boots successfully is the dangerous
kind: nothing looks wrong until an unscanned file has been accepted.

**No default configuration reaches a public cloud.** There is no default S3
endpoint and no default AI base URL. An unconfigured deployment fails; it never
silently connects somewhere.

## Secrets

`.env.example` contains placeholders only. Real credentials belong in your
deployment's secret store and must never reach source control.

Secrets do not appear in logs, API responses, audit events or the browser bundle.
The startup policy check names the _setting_ that is wrong and never its value,
and the storage adapter logs its endpoint and bucket but never its credentials.

## What this actually costs

Nothing here requires a subscription. That is not the same as free.

**Your responsibilities, and their costs:**

- **Servers.** MongoDB, MinIO and ClamAV all want memory. ClamAV alone holds
  roughly 1–2 GB resident for its signature database.
- **Storage capacity.** Uploaded requirement documents accumulate. Budget from
  `UPLOAD_MAX_PROJECT_BYTES` × expected projects, plus MongoDB growth for
  extracted content — which for a large scanned PDF can exceed the file itself.
- **Backups.** Nobody else is taking them. MongoDB holds every project and every
  extraction; MinIO holds the original documents. Losing either loses client
  work, and a recovery link cannot restore what is not there. There are scripts
  and a rehearsed procedure — see
  [backup and restore](backup-and-restore.md).
- **Antivirus definitions.** `freshclam` updates them inside the container by
  default. A scanner with stale signatures runs and detects progressively less —
  an air-gapped deployment must mirror the definitions itself.
- **GPU capacity.** How much depends entirely on the model chosen. A small model
  runs on a CPU slowly; anything larger wants a GPU, and that is real capital or
  rental expense. See
  [self-hosted inference](self-hosted-inference.md).
- **Upgrades and patching.** Five services to keep current, including the
  security-sensitive ones.
- **Licence obligations.** Attribution for MIT/BSD/Apache dependencies; do not
  modify MinIO (AGPL) or offer MongoDB itself as a service (SSPL). See the
  inventory.

**Compared with managed services**, this is more operational work, not less. A
managed database and a hosted model API remove backups, patching, capacity
planning and on-call from your plate, and charge for it. This architecture makes
the opposite trade deliberately: no vendor bill, no metered API, no client
document leaving your network — in exchange for running and maintaining the
infrastructure yourself.

Choose it because you want that trade, not because you expect it to be free.

## Model quality

Self-hosted inference means output quality is bounded by what you can run. A
small model on modest hardware is not a frontier model, and the analysis and
estimates it produces will be correspondingly weaker. This is a permanent,
structural trade-off of the architecture, and it is stated here rather than
discovered later.

The model must permit commercial use, its licence must be recorded in the
inventory, and its weights are never committed to Git. See
[ADR-0017](../adr/0017-self-hosted-ai-inference.md).
