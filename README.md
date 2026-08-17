# website-doc-requirement-generator

Converts client requirements into an approved project baseline, a defensible
effort estimate, a locked technology stack, and seven professional project
documents.

The public workspace needs no account: a project is reached through a private
recovery link.

> **Current state: Phase 14 — final hardening and deployment: the application ships as
> two container images, with a backup procedure that has been restored from and a smoke
> test that runs against a live deployment.**
> You can create a project without an account, receive a private recovery link,
> upload and paste requirement documents, review what was extracted from them,
> analyse them into a traceable requirement baseline — classification,
> duplicates, contradictions, ambiguity, gaps, clarification questions, evidence
> confidence, coverage, alignment and approval — and then decide the technology
> stack against that baseline and lock it as authoritative, and then estimate
> the work: feature and role effort with ranges, a team or a recommended one, a
> schedule from the dependency graph, and an honest answer about whether it fits
> the timeline you asked for. **Effort, duration and capacity are calculated
> separately, and the timeline you set is never changed.** The analysis, the
> technology suggestions and the requirement assessment all run on a model you
> host — see [self-hosted
> inference](docs/operations/self-hosted-inference.md) — and both the stack and
> the estimation steps work end to end with no model at all. All seven controlled
> documents are then generated from those approved artifacts — Our Understanding,
> Feature Listing, Acceptance Criteria, Assumptions, Statement of Work, Work
> Breakdown Structure and Client Dependency Sheet — each locked until the one before
> it is approved, each quoting its inputs rather than deciding them. Every document
> exports as a real file in the formats it supports — DOCX, PDF, XLSX and the strict
> CSV — carrying the project's branding where it is configured, and an archived
> version can be downloaded without restoring it. Operationally the API defends
> itself: per-class request ceilings, a retention job that removes expired and deleted
> content on a schedule you set, and an optional operator console — at `/admin`, behind a
> deployment token — reporting system status, per-project support metadata, extraction
> queue health, audit events and metrics a self-hosted collector can scrape. It deploys as
> two images that run as a non-root user with no package manager in them, behind a backup
> and restore procedure that has been rehearsed by destroying data and recovering it, and
> a smoke test that checks a running deployment end to end from a shell.

---

## Quick start

```bash
corepack enable pnpm       # if pnpm is not already on PATH
pnpm install
cp .env.example .env       # defaults work as-is for local development
pnpm docker:up             # MongoDB on 127.0.0.1:27017
pnpm dev                   # web :3000, api :3001
```

| URL                                    | What            |
| -------------------------------------- | --------------- |
| http://localhost:3000                  | Workspace       |
| http://localhost:3001/api/docs         | OpenAPI UI      |
| http://localhost:3001/api/health/ready | Readiness probe |

Full setup notes and troubleshooting:
[docs/operations/local-development.md](docs/operations/local-development.md).

## Commands

| Command                               | Does                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                            | Both apps in watch mode                                         |
| `pnpm build`                          | Production builds                                               |
| `pnpm test`                           | Unit + component tests — no infrastructure required             |
| `pnpm test:e2e`                       | API integration tests — **requires MongoDB**                    |
| `pnpm test:browser`                   | Browser E2E — **requires MongoDB + Playwright**                 |
| `pnpm lint`                           | ESLint, zero warnings tolerated                                 |
| `pnpm typecheck`                      | `tsc --noEmit` across every package                             |
| `pnpm format` / `format:check`        | Prettier                                                        |
| `pnpm verify`                         | Every gate, in CI order                                         |
| `pnpm docker:up` / `docker:down`      | MongoDB, MinIO and ClamAV                                       |
| `pnpm --filter @wdrg/api test:ollama` | Provider check against a **real local model** — never run by CI |
| `pnpm docker:wait:all`                | Block until every service answers                               |

Scope any command to one package with
`pnpm --filter @wdrg/api <command>`.

## Architecture

```
Browser ──► Next.js (web) ──► NestJS (api) ──► MongoDB
                    └── @wdrg/contracts ──┘
                        one definition of every request,
                        response, error code and workflow constant
```

A **modular monolith**: one deployable API composed of feature modules with
explicit boundaries. Everything crossing the process boundary — AI provider,
object storage, job queue, file extraction, document export — sits behind a port
interface the domain owns.

```
apps/
  api/        NestJS API
  web/        Next.js App Router workspace
  e2e/        Playwright browser suite — drives both apps for real
packages/
  contracts/  Shared API surface — imported by BOTH apps
  config/     Environment validation primitives
  ui/         Accessible presentational primitives
  testing/    Shared test helpers
  eslint-config/, typescript-config/
docs/
  adr/, architecture/, api/, operations/
infrastructure/
  docker/, scripts/
```

Detail: [architecture overview](docs/architecture/overview.md) ·
[repository structure](docs/architecture/repository-structure.md) ·
[API conventions](docs/api/README.md) ·
[project data model](docs/architecture/project-data-model.md) ·
[requirement ingestion](docs/architecture/requirement-ingestion.md) ·
[technology-stack architecture](docs/architecture/technology-stack.md) ·
[estimation architecture](docs/architecture/estimation.md) ·
[dependency inventory](docs/architecture/dependency-and-service-inventory.md) ·
[self-hosting](docs/operations/self-hosting.md) ·
[self-hosted inference](docs/operations/self-hosted-inference.md) ·
[request ceilings](docs/operations/rate-limiting.md) ·
[retention](docs/operations/retention.md) ·
[operator surface](docs/operations/operator-surface.md) ·
[observability](docs/operations/observability.md) ·
[deployment](docs/operations/deployment.md) ·
[backup and restore](docs/operations/backup-and-restore.md) ·
[releases](docs/operations/releases.md) ·
[requirement analysis](docs/product/requirement-analysis.md) ·
[technology stack](docs/product/technology-stack.md) ·
[estimation & timeline](docs/product/estimation-and-timeline.md) ·
[anonymous-access threat model](docs/architecture/anonymous-access-threat-model.md)

## How project access works

There are no accounts. Creating a project returns a **private recovery link**,
and that link is the only way back in:

```
https://your-app/recover#p=prj_XXXXXXXXXXXXXXXXXXXXXXXXXX&s=<recovery secret>
                        ↑ fragment — never sent to the server, never logged
```

- The **project id** names the project and is safe to log or quote.
- The **recovery secret** authorises access. Only a salted scrypt hash is stored,
  so the server cannot re-derive it — and a database leak yields nothing usable.
- Redeeming the link exchanges the secret for an `HttpOnly` session cookie, then
  clears the secret from the address bar.

### What "shown once" means, exactly

The secret is **displayed once** and the link is **reusable**. Those are separate
things, and confusing them is the easiest way to mislead someone into treating a
still-live credential as spent:

- **The secret can be exchanged as often as you like**, from any device or
  browser. Using it does not consume it.
- **Several sessions can be open at once.** Each exchange issues an additional
  session; it does not end the others.
- **The credential dies when the project does** — on deletion or expiry. There is
  no rotation, no revocation endpoint, and no way to un-share a link.
- **Anyone holding the link has full access** — read, edit and delete. Nothing
  distinguishes you from someone you forwarded it to.
- **Deleting or expiring the project ends every open session immediately**, and
  makes further recovery fail.

**A lost link is an unrecoverable project.** The UI states all of this and
requires an acknowledgement before you leave the creation screen. Rationale and
rejected alternatives: [ADR-0010](docs/adr/0010-anonymous-project-access.md).

## Self-hosted by design

> The core application is designed to operate using self-hosted open-source
> components. No paid third-party API or managed SaaS service is required for
> requirement ingestion, OCR, storage, malware scanning, AI processing,
> estimation, document generation, or export.

MongoDB, MinIO, ClamAV, Tesseract, and Ollama or vLLM for inference. All
open-source, all running on hardware you control, and **no client requirement
document ever leaves your network** — the endpoint policy refuses hosted model
vendors outright, in development as well as production.

That is a statement about vendor dependency, not about cost: servers, storage,
GPUs, backups and patching are still yours, and this is more operational work
than a managed stack, not less. See [self-hosting](docs/operations/self-hosting.md)
and the [dependency and service inventory](docs/architecture/dependency-and-service-inventory.md).

## Deploying it

Two images — `wdrg-api` and `wdrg-web` — built from
[`infrastructure/docker/`](infrastructure/docker/), pinned to a base image by digest,
running as a non-root user with no package manager left in them. MongoDB is the only hard
dependency; object storage and malware scanning are configured, and there is no broker,
scheduler or separate worker to deploy.

```bash
# Dependencies plus the application, from the images that ship.
export PROJECT_SESSION_SECRET=$(openssl rand -hex 24)
export ADMIN_API_TOKEN=$(openssl rand -hex 24)   # optional — this is what opens /admin
bash infrastructure/scripts/compose.sh --profile app up --build -d

# Then check the running deployment from a shell. It creates a project, uploads a file,
# recovers a session and deletes what it made — 56 checks, and no toolchain to install.
infrastructure/scripts/smoke-test.sh --production --expect-version 0.1.0 \
  --admin-token "${ADMIN_API_TOKEN}"
```

Production refuses to start when it is configured unsafely, and says every problem at
once. Backups are yours to take, and there is a procedure that has been restored from
rather than only written down.

- [Deployment](docs/operations/deployment.md)
- [Backup and restore](docs/operations/backup-and-restore.md)
- [Releases](docs/operations/releases.md)

## Requirement ingestion

Paste text or upload files; the pipeline validates, stores, reads and — where
there is no text layer — recognises them, then hands you the result to review.

**Supported:** PDF, DOCX, TXT, CSV, XLSX, PNG, JPG, JPEG, WEBP.
`.doc` and `.xls` need a converter that is **off by default** — they are refused
with a message naming the fix rather than silently accepted.

Every extracted block keeps a reference to where it came from — a page, a sheet
and cell, a row, a line — and **nothing is invented**: a block the extractor
could not locate says so rather than citing page 1.

Anything read by text recognition is marked as recognised, carries a confidence
score, and lands in _needs review_ rather than _ready_. Corrections are saved as
new revisions and the original extraction is never overwritten, so restoring it
is a read rather than an undo.

**Uploaded content is evidence, never instruction.** A document containing
"ignore all previous instructions" is stored verbatim, flagged for the user, and
cannot change how the application behaves — see the
[ingestion architecture](docs/architecture/requirement-ingestion.md).

Requires **Tesseract** for text recognition (`OCR_ENABLED=false` to run without
it). Files are stored on local disk, outside every static directory, and reached
only through an authorized API route.

## Controlled documents

Seven documents, one engine. `DocumentsService` owns the status machine,
currentness, versioning, edit protection, the dependency graph, propagation,
validation and approval; a composer owns what is true of one document. As of Phase 9
all seven are implemented: Our Understanding, Feature Listing, Acceptance Criteria,
Assumptions, Statement of Work, Work Breakdown Structure and Client Dependency Sheet.
The implemented-type gate remains, because the next document declared before it is
built will need it again.

Each document is locked until the one before it is approved, and a document quotes its
inputs rather than deciding them: hours come from the approved estimate, technologies
from the locked stack, and the timeline in the only form the approved schedule permits.

Three rules are worth stating outright, because each is a way this application could
have done real damage and does not:

- **an acceptance condition cannot invent a commitment.** A response time, an
  availability figure or a compliance standard that is not in the approved
  requirements blocks approval — see [documents](docs/product/documents.md);
- **missing information does not become an assumption.** An assumption needs a person
  behind it; a gap is a question to ask —
  [ADR-0036](docs/adr/0036-assumption-provenance.md);
- **the Statement of Work invents no legal or commercial term**, and names what is
  missing as missing — [ADR-0037](docs/adr/0037-statement-of-work-boundary.md);
- **the work breakdown is the approved plan, not a second opinion about it.** Hours,
  working days and the critical path are copied from the approved estimate and proved
  to match it role by role —
  [ADR-0038](docs/adr/0038-work-breakdown-projects-the-approved-plan.md);
- **on the dependency sheet, received is not accepted**, and a credential value is
  refused before it can be stored —
  [ADR-0039](docs/adr/0039-received-is-not-accepted.md);
- **approval applies to the exact content that was approved.** Editing an approved
  document requires approving it again; an upstream change leaves the approval standing
  and marks the document out of date. Every content change keeps the version before it —
  [ADR-0040](docs/adr/0040-a-version-per-change.md);
- **traceability shows gaps rather than hiding them.** Every link is one a document
  recorded, never inferred from prose —
  [ADR-0041](docs/adr/0041-traceability-is-derived-never-inferred.md).

## Key decisions

Recorded as [ADRs](docs/adr/), with the reasoning and the rejected alternatives:

| ADR                                                                | Decision                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [0001](docs/adr/0001-monorepo-with-pnpm-and-turborepo.md)          | Monorepo with pnpm + Turborepo — so a contract and both sides of it change atomically |
| [0002](docs/adr/0002-modular-monolith.md)                          | Modular monolith, not microservices                                                   |
| [0003](docs/adr/0003-typescript-version-pinning.md)                | TypeScript 5.9 pinned — 7.x is unsupported by the lint toolchain                      |
| [0004](docs/adr/0004-mongodb-as-primary-store.md)                  | MongoDB, with binaries in object storage and referential data in separate collections |
| [0005](docs/adr/0005-ports-and-adapters.md)                        | Ports and adapters for every external system                                          |
| [0006](docs/adr/0006-api-error-model-and-correlation-ids.md)       | One error envelope, correlation ids end to end                                        |
| [0007](docs/adr/0007-zod-as-single-schema-language.md)             | Zod as the single schema language                                                     |
| [0008](docs/adr/0008-test-strategy-and-runners.md)                 | Layered tests; unit suite never needs infrastructure                                  |
| [0011](docs/adr/0011-file-storage-provider.md)                     | Filesystem storage now, S3 behind the same port                                       |
| [0012](docs/adr/0012-job-queue-provider.md)                        | A MongoDB job queue rather than Redis — one fewer stateful service                    |
| [0013](docs/adr/0013-extraction-libraries.md)                      | One extractor per format, behind a registry                                           |
| [0014](docs/adr/0014-ocr-provider.md)                              | Tesseract as a local binary, behind an OCR port                                       |
| [0015](docs/adr/0015-legacy-file-strategy.md)                      | A conversion boundary for .doc and .xls, off by default                               |
| [0016](docs/adr/0016-source-revision-model.md)                     | Append-only content revisions with an explicit effective pointer                      |
| [0017](docs/adr/0017-self-hosted-ai-inference.md)                  | Self-hosted inference, never a hosted model vendor                                    |
| [0018](docs/adr/0018-model-profile-strategy.md)                    | Model profiles as data, not a hardcoded choice                                        |
| [0019](docs/adr/0019-prompt-versioning.md)                         | Versioned, registered, checksummed prompts                                            |
| [0020](docs/adr/0020-structured-output-repair.md)                  | Bounded repair; unvalidated model output is never persisted                           |
| [0021](docs/adr/0021-inference-endpoint-hardening.md)              | Connect to a validated address, not to a name                                         |
| [0022](docs/adr/0022-chunking-and-reconciliation.md)               | Chunk, then reconcile across the chunks                                               |
| [0023](docs/adr/0023-two-confidences.md)                           | Two confidences; only the evidence-derived one governs                                |
| [0024](docs/adr/0024-baseline-lifecycle.md)                        | The baseline earns its numbers; versions supersede                                    |
| [0025](docs/adr/0025-clarification-integration.md)                 | A confirmed clarification is evidence, not an assumption                              |
| [0009](docs/adr/0009-request-validation-and-mapping.md)            | Reject undeclared properties; map explicitly to domain types                          |
| [0010](docs/adr/0010-anonymous-project-access.md)                  | Anonymous access: split identifier, secret in the URL fragment, stateless session     |
| [0033](docs/adr/0033-shared-document-engine.md)                    | One document engine, seven documents                                                  |
| [0034](docs/adr/0034-document-authority.md)                        | A document quotes its inputs; it never decides them                                   |
| [0035](docs/adr/0035-document-status-and-currentness.md)           | Lifecycle status and currentness are two axes                                         |
| [0036](docs/adr/0036-assumption-provenance.md)                     | An assumption needs somebody behind it                                                |
| [0037](docs/adr/0037-statement-of-work-boundary.md)                | The Statement of Work is contract-ready, and is not a contract                        |
| [0038](docs/adr/0038-work-breakdown-projects-the-approved-plan.md) | The work breakdown projects the approved plan; it never re-derives it                 |
| [0039](docs/adr/0039-received-is-not-accepted.md)                  | Received is not accepted, and credentials are never stored                            |

## Technology

| Layer   | Choice                                                                             |
| ------- | ---------------------------------------------------------------------------------- |
| Web     | Next.js 16 (App Router), React 19, TanStack Query, React Hook Form, Tailwind CSS 4 |
| API     | NestJS 11, Express, Mongoose 9, Terminus, pino                                     |
| Shared  | TypeScript 5.9 (strict), Zod 4                                                     |
| Tooling | pnpm 11 workspaces, Turborepo 2, ESLint 10 (flat), Prettier 3                      |
| Tests   | Jest + SWC (API), Vitest + Testing Library + axe-core (web/packages)               |

## Code standards

Enforced by tooling, not by convention:

- TypeScript strict mode everywhere, including `noUncheckedIndexedAccess`. No
  unjustified `any`.
- `process.env` is readable **only** inside a configuration module — enforced by
  an ESLint rule.
- No business logic in React components or NestJS controllers.
- Errors are never swallowed silently; `no-floating-promises` and
  `no-misused-promises` are errors.
- Lint runs with `--max-warnings 0`. A warning nobody must fix is a warning
  everybody ignores.
- Every external boundary is an interface the domain owns.

## Quality gates

CI runs on every push and pull request:

| Gate              | Command                                                  |
| ----------------- | -------------------------------------------------------- |
| Formatting        | `pnpm format:check`                                      |
| Lint              | `pnpm lint`                                              |
| Types             | `pnpm typecheck`                                         |
| Unit tests        | `pnpm test`                                              |
| Integration tests | `pnpm test:e2e` (MongoDB service container)              |
| Browser E2E       | `pnpm test:browser` (MongoDB + Chromium)                 |
| Production build  | `pnpm build`                                             |
| Dependency audit  | `pnpm audit --audit-level high` (gating)                 |
| Deployable images | build, inspect, run, smoke test, scan, restore rehearsal |

`pnpm verify` runs the gates that need nothing but the repository: formatting, lint,
types, unit tests and the build. The other three need infrastructure and stay separate —
MongoDB for the two test suites, and Docker for the images gate, which builds both
images, runs them, drives them over HTTP, scans them and rehearses a backup restore. What
it does and what it publishes: [releases](docs/operations/releases.md#what-ci-publishes).

## Security

Implemented in Phase 1, each covered by a test:

- Startup configuration validation (a bad deployment fails immediately).
- **API response headers** via helmet, asserted in `apps/api/src/security.spec.ts`.
  This includes **helmet's default Content-Security-Policy in production**
  (`default-src 'self'`, `object-src 'none'`, …); it is disabled outside
  production so the Swagger UI works.
- **Web response headers** (`X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control`), asserted in
  `apps/web/src/lib/security-headers.test.ts`. **The web application sends no
  CSP** — see below.
- CORS allow-list, request body limits, validated correlation ids (control
  characters rejected, not sanitised), central log redaction, an error model that
  cannot leak internals, no committed credentials.
- Request validation that rejects undeclared properties at any depth, refuses
  prototype-polluting keys, and forces an explicit request-to-domain mapping.

Added by later phases, and present today:

| Control                                                    | Phase |
| ---------------------------------------------------------- | ----- |
| Anonymous project access, session cookies                  | 2     |
| Upload validation, magic-byte checks, malware scanning     | 3     |
| Rate limiting, quotas, retention, cleanup                  | 12    |
| Non-root images, no package manager, base pinned by digest | 14    |

Still deferred — not present today:

| Control                                      | Phase        |
| -------------------------------------------- | ------------ |
| **Application-specific CSP for the web app** | not assigned |
| CAPTCHA                                      | not assigned |

The web app still has no CSP, because writing one means guessing the runtime origins
it will need (object storage, CAPTCHA, analytics), and a CSP written against a guess
is one that gets switched off the first time it breaks a feature. The API's CSP is
real and tested, but it protects API responses only — it does nothing for the web
app's HTML. No CAPTCHA ships either: the request ceilings added in Phase 12 address
the abuse this deployment actually faces, and a CAPTCHA would mean either a
third-party service or a self-hosted challenge system.

Never commit a `.env`. `.env.example` documents every variable and must stay free
of secrets.

## Roadmap

| Phase | Delivers                                             | Status       |
| ----- | ---------------------------------------------------- | ------------ |
| 1     | Repository foundation and architecture               | **Complete** |
| 2     | Public workspace, anonymous project lifecycle        | **Complete** |
| 3     | Upload, storage, extraction, OCR                     | **Complete** |
| 4     | Requirement analysis, conflicts, baseline            | **Complete** |
| 5     | Technology-stack recommendation and locking          | **Complete** |
| 6     | Estimation and timeline planning                     | **Complete** |
| 7     | Document engine + Our Understanding, Feature Listing | **Complete** |
| 8     | Acceptance Criteria, Assumptions, Statement of Work  | **Complete** |
| 9     | Work Breakdown Structure, Client Dependency Sheet    | **Complete** |
| 10    | Editing, versioning, invalidation                    | **Complete** |
| 11    | Export and branding                                  | **Complete** |
| 12    | Operational hardening: abuse controls, retention     | **Complete** |
| 13    | Admin, observability and operations                  | **Complete** |
| 14    | Final hardening and deployment                       | **Complete** |
