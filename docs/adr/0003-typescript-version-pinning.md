# ADR-0003: Pin TypeScript 5.9 rather than adopt 7.x

## Status

Accepted (Phase 1)

## Context

The brief calls for the latest stable, **mutually compatible** versions,
verified against official sources rather than assumed.

At implementation time (2026-08-03), `typescript@latest` resolves to **7.0.2** —
the native compiler rewrite. Checking the toolchain that has to consume it:

```
$ npm view typescript-eslint@8.65.0 peerDependencies
{ "eslint": "^8.57.0 || ^9.0.0 || ^10.0.0",
  "typescript": ">=4.8.4 <6.1.0" }
```

The current type-aware linting stack declares support only up to TypeScript 6.
Adopting 7.x would mean either running the linter against an unsupported compiler
or dropping type-aware lint rules — and those rules (`no-floating-promises`,
`no-misused-promises`, `no-unsafe-*`) are the ones that actually catch defects in
an async, DI-heavy NestJS codebase.

NestJS 11 additionally depends on `experimentalDecorators` and
`emitDecoratorMetadata`, whose behaviour under the rewritten compiler is not
something to discover mid-project.

## Decision

Pin **TypeScript 5.9.3** across every workspace package, as an exact version
rather than a range.

"Latest stable" is read as latest stable _that the required toolchain supports_.
A compiler the linter cannot analyse is not compatible, whatever its version
number says.

The pin is exact so all nine packages compile with one compiler. A range would
let pnpm resolve different minors per package, producing type errors that appear
in one package and not another.

## Consequences

- Type-aware linting works, which is where a large share of this project's
  automated defect detection comes from.
- `pnpm install` prints a "7.0.2 is available" notice. That is expected; this ADR
  is the answer to it.
- The upgrade is deferred, not abandoned. Revisit when `typescript-eslint`
  publishes a release declaring TypeScript 7 support — at that point re-run the
  full gate on a branch before switching.
- Every package pins the same version, so a contributor cannot accidentally
  introduce a second compiler through a transitive range.

## Alternatives considered

**Adopt TypeScript 7 and disable type-aware lint rules.** Rejected: it trades the
project's strongest static-analysis layer for a version number.

**Adopt TypeScript 7 and lint with an unsupported compiler.** Rejected: outside
the supported range, failures are silent or bizarre, and debugging them is not
work this project should be doing.

**Use a caret range (`^5.9.3`).** Rejected: nine packages resolving independently
is a class of bug with no upside. Renovate/Dependabot can propose the bump
explicitly.
