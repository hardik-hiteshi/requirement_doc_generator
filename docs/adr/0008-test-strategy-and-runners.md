# ADR-0008: Layered test strategy with two runners

## Status

Accepted (Phase 1)

## Context

The brief requires unit, integration, component, accessibility and end-to-end
coverage. Two constraints shape how that is arranged:

- **NestJS depends on decorator metadata.** A runner must apply
  `emitDecoratorMetadata` correctly or dependency injection fails in tests in
  ways that look like application bugs.
- **A test suite that needs infrastructure is a suite people skip.** If
  `pnpm test` requires Docker and a running MongoDB, it stops being run locally,
  and the feedback loop that makes tests useful disappears.

## Decision

**Two runners, chosen per environment rather than standardised for its own
sake:**

| Scope                       | Runner                   | Why                                                                                                                       |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| API unit + service          | Jest + `@swc/jest`       | The Nest ecosystem targets Jest; SWC applies the same decorator transform as the production build, via the same `.swcrc`. |
| API integration             | Jest, separate config    | Boots the real app over HTTP with supertest.                                                                              |
| Web unit + component + a11y | Vitest + Testing Library | Shares the app's Vite-compatible transform pipeline; no second toolchain for JSX and ESM.                                 |
| Shared packages             | Vitest                   | Framework-free code; fastest option.                                                                                      |
| End-to-end                  | Playwright (Phase 14)    | Real browser against the deployed stack.                                                                                  |

**Tests are split by infrastructure requirement, not by name:**

- `pnpm test` — unit and component tests only. No database, no network, no
  Docker. Runs anywhere in seconds.
- `pnpm test:e2e` — integration tests that need MongoDB. Explicit and separate,
  with its own Jest config and a service container in CI.

Both run in CI. Only the first is expected to run constantly during development.

**Assertions target behaviour and contracts, not implementation.** Health and
error tests assert against the shared Zod schemas, so a response that drifts from
the published contract fails the test — the test cannot rot into asserting
whatever the code happens to produce.

**Accessibility is asserted in component tests** via axe-core through
`@wdrg/testing`, at WCAG 2.2 AA rule tags. Automated checks catch perhaps a third
of real issues; they are a regression guard, not a substitute for the manual
audit in the hardening phase.

## Consequences

- Two runner configurations to maintain, and two sets of mocking APIs
  (`jest.fn()` vs `vi.fn()`). Contained, because the split follows the app
  boundary — no one file needs both.
- The unit suite stays fast and infrastructure-free, which is what keeps it in
  the edit-run loop.
- Sharing `.swcrc` between `nest build` and `@swc/jest` means tests and
  production compile decorators identically. A DI failure in tests is a real
  failure, not a configuration artefact.
- CI runs the integration job with a MongoDB service container and waits for
  readiness with a real check rather than a fixed sleep.
- Lint runs with `--max-warnings 0`. A warning nobody must fix is a warning
  everybody ignores.

## Alternatives considered

**Vitest everywhere, including the API.** Tempting for uniformity. Rejected:
Vitest with NestJS needs `unplugin-swc` and careful decorator-metadata
configuration, and the ecosystem's examples, matchers and troubleshooting all
assume Jest. Uniformity is not worth debugging DI metadata.

**Jest everywhere, including the web app.** Rejected: Jest with Next.js, ESM and
JSX needs its own transform configuration that duplicates what Vite already does
correctly.

**One combined test command requiring Docker.** Rejected for the reason in the
context: it is the reliable way to make a suite stop being run.

**`ts-jest` instead of `@swc/jest`.** Rejected: materially slower, and it would
type-check twice (the `typecheck` gate already does that properly).
