# website-doc-requirement-generator

Converts client requirements into an approved project baseline, a defensible
effort estimate, a locked technology stack, and seven professional project
documents.

The public workspace needs no account: a project is reached through a private
recovery link.

> **Current state: Phase 1 — repository foundation and architecture.**
> The monorepo, both applications, the shared contracts, configuration
> validation, structured logging, health probes, the API error model, CI and the
> workspace shell are implemented and verified. The product workflow itself
> (project creation, uploads, analysis, estimation, document generation, export)
> is **not** implemented — see [Roadmap](#roadmap).

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

| Command                          | Does                                                |
| -------------------------------- | --------------------------------------------------- |
| `pnpm dev`                       | Both apps in watch mode                             |
| `pnpm build`                     | Production builds                                   |
| `pnpm test`                      | Unit + component tests — no infrastructure required |
| `pnpm test:e2e`                  | API integration tests — **requires MongoDB**        |
| `pnpm lint`                      | ESLint, zero warnings tolerated                     |
| `pnpm typecheck`                 | `tsc --noEmit` across every package                 |
| `pnpm format` / `format:check`   | Prettier                                            |
| `pnpm verify`                    | Every gate, in CI order                             |
| `pnpm docker:up` / `docker:down` | Local MongoDB                                       |

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
[API conventions](docs/api/README.md)

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
| [0009](docs/adr/0009-request-validation-and-mapping.md)      | Reject undeclared properties; map explicitly to domain types                          |

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
| 2     | Public workspace, anonymous project lifecycle        | Planned      |
| 3     | Upload, storage, extraction, OCR                     | Planned      |
| 4     | Requirement analysis, conflicts, baseline            | Planned      |
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
