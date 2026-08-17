# Architecture overview

> Status: reflects the codebase as of **Phase 14**, which is every phase this
> repository has. Nothing below describes intent rather than shipped behaviour;
> where something is deliberately absent, it says so and says why.

## What the system does

A user arrives with client requirements — pasted text, a PDF, a spreadsheet, a
screenshot — and leaves with an approved requirement baseline, a defensible
effort estimate, a locked technology stack, and seven exportable project
documents. No account, no login: a project is reached through a private recovery
link.

## Shape of the system

```
                    Browser (public, no account)
                              │
                      HTTPS + session cookie
                              │
                   ┌──────────▼──────────┐
                   │   Next.js (web)     │   single workspace surface
                   │   App Router        │   TanStack Query + RHF + Zod
                   └──────────┬──────────┘
                              │  /api/v1/*  ── @wdrg/contracts ──┐
                   ┌──────────▼──────────┐                       │
                   │   NestJS (api)      │   shared types make    │
                   │   modular monolith  │   both sides agree     │
                   └──────────┬──────────┘                       │
                              │                                  │
     ┌────────────┬───────────┼────────────┬─────────────┐       │
     │            │           │            │             │       │
 ┌───▼───┐  ┌─────▼─────┐ ┌───▼────┐ ┌─────▼─────┐ ┌─────▼────┐  │
 │MongoDB│  │  Storage  │ │  Jobs  │ │ AI        │ │ Export   │  │
 │       │  │  (port)   │ │ (port) │ │ provider  │ │ (port)   │  │
 │       │  │           │ │        │ │ (port)    │ │          │  │
 └───────┘  └───────────┘ └────────┘ └───────────┘ └──────────┘  │
              Phase 3        Phase 3     Phase 4       Phase 11   │
                                                                  │
   Everything crossing the process boundary sits behind a port ───┘
   (ADR-0005). Phase 1 defined the interfaces; the phase beneath
   each one is where its adapter shipped. All of them exist today.
```

## Layers inside the API

```
Controller   HTTP only: routing, status codes, OpenAPI annotations.
             No business logic — a controller that makes a decision is a bug.
     │
Service      The domain. Orchestrates, enforces rules, owns the unit of work.
     │
Repository   Persistence. The only layer that knows about Mongoose.
     │
Port         Everything external, behind an interface the domain owns.
```

Cross-cutting concerns are wired once, globally, rather than per module:

| Concern       | Where                | Effect                                                                                                                    |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Configuration | `src/config`         | The only place `process.env` is read. Validated at startup; a bad deployment fails immediately with every problem listed. |
| Logging       | `src/common/logging` | Structured JSON via pino. Every line carries the request's correlation id. Sensitive headers redacted centrally.          |
| Errors        | `src/common/errors`  | One global filter maps every thrown value to one envelope. Internals never reach the client.                              |
| Health        | `src/health`         | Version-neutral liveness and readiness, so probes survive an API version bump.                                            |
| Persistence   | `src/database`       | Single Mongoose connection with command buffering off, so an outage reads as "not ready" rather than as slow requests.    |

## Request lifecycle

1. **Correlation id** — resolved before anything is logged, so even a request
   that never reaches a route (404, oversized body) is traceable. A caller's
   `x-request-id` is adopted only after validation; anything with a control
   character is rejected rather than sanitised.
2. **Security headers and CORS** — helmet, plus an explicit allow-list of
   origins. The correlation id header is exposed to the browser.
3. **Body limit** — enforced before parsing, from configuration.
4. **Routing** — global `api` prefix, URI versioning (`/api/v1/...`). Health is
   version-neutral (`/api/health/...`).
5. **Validation** — Zod at the boundary. Undeclared properties are rejected at
   any depth by default, and prototype-polluting keys (`__proto__`,
   `constructor`, `prototype`) are always refused. This narrows over-posting; it
   does not eliminate it on its own, because a schema can still declare a field
   a client should not control. The mapping layer is what closes that — see
   below.
6. **Mapping** — a validated input is turned into a domain object by an explicit
   mapping function. The pipe's output type is the domain type, so a controller
   has no request-shaped value in scope to forward to a repository.
7. **Handler** — controller delegates immediately to a service.
8. **Response or error** — success serialises normally; any thrown value becomes
   the standard envelope, with the correlation id in both header and body.

## The workflow

Ten steps, defined once in `@wdrg/contracts` so the UI and the persisted project
state share one vocabulary:

```
project details → requirement input → extraction review → requirement analysis
   → clarifications → baseline approval → technology stack
   → estimation & timeline → document generation → export & recovery
```

Two rules govern it, and both are live for every step above — including document
generation and export, which shipped in Phases 7 to 11.

- **Approval gates progression.** The approved requirement baseline is the source
  of truth for everything downstream, and the technology stack refuses to be
  approved without one. The locked stack is in turn authoritative and is never
  silently replaced — it emits a `DownstreamAuthority` contract that later phases
  read, and `GET /stack/authority` refuses anything that is not locked. See
  [technology stack](technology-stack.md).
- **Changing an approved artefact invalidates what depended on it.** A document
  arriving after a baseline is approved marks it out of date; a baseline going out
  of date marks the stack out of date; unlocking a stack supersedes it and creates
  a new version. In every case the approved artefact keeps saying exactly what it
  said, and the user decides what to do — nothing is silently regenerated.

## Security posture

Shipped in Phase 1, each with a test:

| Control                                             | Where                | Test                            |
| --------------------------------------------------- | -------------------- | ------------------------------- |
| Configuration validated at startup                  | `src/config`         | `src/config/env.schema.spec.ts` |
| helmet headers, **including a CSP in production**   | `src/security.ts`    | `src/security.spec.ts`          |
| CORS allow-list, correlation id exposed             | `src/security.ts`    | `src/security.spec.ts`          |
| Request body limit                                  | `src/security.ts`    | `src/security.spec.ts`          |
| Correlation id validated, not sanitised             | `src/common/logging` | `correlation-id.spec.ts`        |
| Log redaction of sensitive headers                  | `src/common/logging` | — (configuration)               |
| Error envelope leaks no internals                   | `src/common/errors`  | `all-exceptions.filter.spec.ts` |
| Undeclared / prototype-polluting properties refused | `src/common/pipes`   | `zod-validation.pipe.spec.ts`   |
| Explicit request-to-domain mapping                  | `src/common/mapping` | `request-mapper.spec.ts`        |

**Content-Security-Policy — the precise position.** The API sends helmet's
_default_ CSP in production and none outside it (the Swagger UI needs inline
scripts). The **web application sends no CSP at all**. An
application-specific policy for the web app is not yet assigned to a phase, and waits
until the runtime origins it must allow are known.

Added by later phases: anonymous project access and session cookies (2); upload
validation, magic bytes, malware scanning (3); rate limiting, quotas, retention and
cleanup (12); an operator surface behind a deployment token, with every access audited
(12 and 13); and images that run as a non-root user with no package manager in them,
built from a base pinned by digest (14).

Still not present: a web-application CSP, and CAPTCHA. Neither is assigned to a phase.

## Where to look

| Question                   | File                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| Repository layout          | [repository-structure.md](repository-structure.md)                       |
| Why the big decisions      | [../adr/](../adr/)                                                       |
| Error model and versioning | [../api/README.md](../api/README.md)                                     |
| Running it locally         | [../operations/local-development.md](../operations/local-development.md) |
| Running it somewhere real  | [../operations/deployment.md](../operations/deployment.md)               |
| The external boundaries    | `apps/api/src/ports/README.md`                                           |
