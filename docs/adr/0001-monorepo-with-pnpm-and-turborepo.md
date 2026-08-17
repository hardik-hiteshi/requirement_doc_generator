# ADR-0001: Monorepo with pnpm workspaces and Turborepo

## Status

Accepted (Phase 1)

## Context

The product is one system with two deployables — a Next.js workspace and a
NestJS API — that must agree exactly on the shape of every request, response and
error. They also share a workflow vocabulary (the ten steps, the seven
documents) that appears in both the UI and the persistence layer.

Split across two repositories, that agreement is maintained by publishing a
versioned package and by discipline. In practice it is maintained by neither: a
field gets added on the server, the client's copy of the type drifts, and the
mismatch is found by a user rather than by the compiler.

The repository was empty, so there was no existing structure to preserve.

## Decision

A single repository containing `apps/*` (deployables) and `packages/*` (shared
libraries), using **pnpm workspaces** for dependency resolution and **Turborepo**
for task orchestration.

Shared contracts live in `@wdrg/contracts` and are imported by both applications,
so a breaking change to the API surface fails the type check in the client during
the same commit that introduces it.

pnpm specifically, over npm or yarn:

- Its default `node_modules` layout is non-flat, so a package can only import
  what it actually declares. Phantom dependencies fail at install time rather
  than in production after an unrelated upgrade.
- Content-addressed storage keeps disk use and install time low across nine
  workspace packages.
- `workspace:*` protocol makes internal dependencies explicit and unambiguous.

Turborepo, over plain `pnpm -r` scripts:

- It derives the task graph from the dependency graph, so `pnpm build` builds
  `@wdrg/contracts` before the apps that consume it without any hand-maintained
  ordering.
- Content-hash caching makes the unchanged parts of a quality gate free, which is
  what keeps a five-gate CI pipeline fast enough that nobody is tempted to skip
  one.

## Consequences

- One pull request can change a contract and both sides of it, atomically. This
  is the main benefit and it compounds with every phase.
- Every quality gate runs across the whole workspace, so a change to a shared
  package cannot pass CI while breaking a consumer.
- The repository has more moving parts than a single application would: nine
  `package.json` files, a task graph, and a caching layer. The cost is one-time
  setup; it is documented in the README so it does not become tribal knowledge.
- Deployment must select the right app to build. `turbo build --filter` handles
  this. **Since then:** Phase 14's images select with `pnpm --filter <project> build`
  instead — inside a container the task graph has nothing to cache against, and each
  image builds exactly one application plus the two workspace packages it needs.
- Turborepo collects anonymous telemetry by default. `TURBO_TELEMETRY_DISABLED=1`
  is set in CI, and the README documents `pnpm turbo telemetry disable` for local
  machines.

## Alternatives considered

**Two repositories with a published contracts package.** Rejected: it converts
every contract change into a publish-then-consume cycle, and the window between
those steps is exactly where drift enters. It also makes an atomic change
impossible, which matters most during the phases that redesign the API surface.

**A single application (Next.js API routes only).** Rejected: the brief requires
NestJS, and the work here — long-running extraction, OCR, AI orchestration,
scheduled retention — wants a real server process with dependency injection,
lifecycle hooks and background jobs, not serverless request handlers.

**Nx instead of Turborepo.** Nx is more capable, particularly its generators and
module-boundary enforcement. Rejected for now as more machinery than a two-app
workspace needs; the boundary rules we care about are already enforced by
`package.json` dependencies under pnpm's strict layout. Worth revisiting if the
workspace grows past a handful of apps.
