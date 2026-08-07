# website-doc-requirement-generator

Converts client requirements into an approved project baseline, a defensible
effort estimate, a locked technology stack, and seven professional project
documents.

The public workspace needs no account: a project is reached through a private
recovery link.

> **Current state: Phase 4 — AI-assisted requirement analysis.**
> You can create a project without an account, receive a private recovery link,
> upload and paste requirement documents, review what was extracted from them,
> then analyse them into a traceable requirement baseline: classification,
> duplicates, contradictions, ambiguity, gaps, clarification questions, evidence
> confidence, coverage, alignment and approval. **The analysis runs on a model
> you host** — see [self-hosted
> inference](docs/operations/self-hosted-inference.md). Technology-stack
> recommendation, estimation and document generation are **not** implemented —
> see [Roadmap](#roadmap).

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
[dependency inventory](docs/architecture/dependency-and-service-inventory.md) ·
[self-hosting](docs/operations/self-hosting.md) ·
[self-hosted inference](docs/operations/self-hosted-inference.md) ·
[requirement analysis](docs/product/requirement-analysis.md) ·
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

## Key decisions

Recorded as [ADRs](docs/adr/), with the reasoning and the rejected alternatives:

| ADR                                                          | Decision                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [0001](docs/adr/0001-monorepo-with-pnpm-and-turborepo.md)    | Monorepo with pnpm + Turborepo — so a contract and both sides of it change atomically |
| [0002](docs/adr/0002-modular-monolith.md)                    | Modular monolith, not microservices                                                   |
| [0003](docs/adr/0003-typescript-version-pinning.md)          | TypeScript 5.9 pinned — 7.x is unsupported by the lint toolchain                      |
| [0004](docs/adr/0004-mongodb-as-primary-store.md)            | MongoDB, with binaries in object storage and referential data in separate collections |
| [0005](docs/adr/0005-ports-and-adapters.md)                  | Ports and adapters for every external system                                          |
| [0006](docs/adr/0006-api-error-model-and-correlation-ids.md) | One error envelope, correlation ids end to end                                        |
| [0007](docs/adr/0007-zod-as-single-schema-language.md)       | Zod as the single schema language                                                     |
| [0008](docs/adr/0008-test-strategy-and-runners.md)           | Layered tests; unit suite never needs infrastructure                                  |
| [0011](docs/adr/0011-file-storage-provider.md)               | Filesystem storage now, S3 behind the same port                                       |
| [0012](docs/adr/0012-job-queue-provider.md)                  | A MongoDB job queue rather than Redis — one fewer stateful service                    |
| [0013](docs/adr/0013-extraction-libraries.md)                | One extractor per format, behind a registry                                           |
| [0014](docs/adr/0014-ocr-provider.md)                        | Tesseract as a local binary, behind an OCR port                                       |
| [0015](docs/adr/0015-legacy-file-strategy.md)                | A conversion boundary for .doc and .xls, off by default                               |
| [0016](docs/adr/0016-source-revision-model.md)               | Append-only content revisions with an explicit effective pointer                      |
| [0017](docs/adr/0017-self-hosted-ai-inference.md)            | Self-hosted inference, never a hosted model vendor                                    |
| [0018](docs/adr/0018-model-profile-strategy.md)              | Model profiles as data, not a hardcoded choice                                        |
| [0019](docs/adr/0019-prompt-versioning.md)                   | Versioned, registered, checksummed prompts                                            |
| [0020](docs/adr/0020-structured-output-repair.md)            | Bounded repair; unvalidated model output is never persisted                           |
| [0021](docs/adr/0021-inference-endpoint-hardening.md)        | Connect to a validated address, not to a name                                         |
| [0022](docs/adr/0022-chunking-and-reconciliation.md)         | Chunk, then reconcile across the chunks                                               |
| [0023](docs/adr/0023-two-confidences.md)                     | Two confidences; only the evidence-derived one governs                                |
| [0024](docs/adr/0024-baseline-lifecycle.md)                  | The baseline earns its numbers; versions supersede                                    |
| [0025](docs/adr/0025-clarification-integration.md)           | A confirmed clarification is evidence, not an assumption                              |
| [0009](docs/adr/0009-request-validation-and-mapping.md)      | Reject undeclared properties; map explicitly to domain types                          |
| [0010](docs/adr/0010-anonymous-project-access.md)            | Anonymous access: split identifier, secret in the URL fragment, stateless session     |

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

| Gate              | Command                                     |
| ----------------- | ------------------------------------------- |
| Formatting        | `pnpm format:check`                         |
| Lint              | `pnpm lint`                                 |
| Types             | `pnpm typecheck`                            |
| Unit tests        | `pnpm test`                                 |
| Integration tests | `pnpm test:e2e` (MongoDB service container) |
| Browser E2E       | `pnpm test:browser` (MongoDB + Chromium)    |
| Production build  | `pnpm build`                                |
| Dependency audit  | `pnpm audit --audit-level high` (gating)    |

`pnpm verify` runs the same sequence locally.

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

Deferred, by phase — none of these are present today:

| Control                                                | Phase |
| ------------------------------------------------------ | ----- |
| **Application-specific CSP for the web app**           | 12    |
| Anonymous project access, session cookies              | 2     |
| Upload validation, magic-byte checks, malware scanning | 3     |
| Rate limiting, CAPTCHA, quotas, retention, cleanup     | 12    |

The web app has no CSP because writing one now means guessing the runtime origins
it will need (object storage, CAPTCHA, analytics), and a CSP written against a
guess is one that gets switched off the first time it breaks a feature. The API's
CSP is real and tested, but it protects API responses only — it does nothing for
the web app's HTML.

Never commit a `.env`. `.env.example` documents every variable and must stay free
of secrets.

## Roadmap

| Phase | Delivers                                             | Status       |
| ----- | ---------------------------------------------------- | ------------ |
| 1     | Repository foundation and architecture               | **Complete** |
| 2     | Public workspace, anonymous project lifecycle        | **Complete** |
| 3     | Upload, storage, extraction, OCR                     | **Complete** |
| 4     | Requirement analysis, conflicts, baseline            | **Complete** |
| 5     | Technology-stack recommendation and locking          | Planned      |
| 6     | Estimation and timeline planning                     | Planned      |
| 7     | Document engine + Our Understanding, Feature Listing | Planned      |
| 8     | Acceptance Criteria, Assumptions, Statement of Work  | Planned      |
| 9     | Work Breakdown Structure, Client Dependency Sheet    | Planned      |
| 10    | Editing, versioning, invalidation                    | Planned      |
| 11    | Export and branding                                  | Planned      |
| 12    | Security, abuse controls, retention                  | Planned      |
| 13    | Admin, observability, operations                     | Planned      |
| 14    | Final hardening and deployment                       | Planned      |
