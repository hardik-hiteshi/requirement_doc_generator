# Repository structure

```
website-doc-requirement-generator/
├── apps/
│   ├── api/                    NestJS API (modular monolith)
│   │   ├── src/
│   │   │   ├── common/         Cross-cutting: errors, logging, pipes
│   │   │   ├── config/         The ONLY place process.env is read
│   │   │   ├── database/       Mongoose connection
│   │   │   ├── health/         Liveness + readiness probes
│   │   │   ├── ports/          Outbound boundaries (interfaces, no adapters yet)
│   │   │   ├── app.module.ts   Composition root
│   │   │   └── main.ts         Bootstrap: security, versioning, OpenAPI
│   │   └── test/               Integration tests (need MongoDB)
│   │
│   └── web/                    Next.js App Router workspace
│       └── src/
│           ├── app/            Routes, layout, providers
│           ├── components/     Feature components
│           └── lib/            API client, env config, query keys
│
├── packages/
│   ├── contracts/              Shared API surface — imported by BOTH apps
│   ├── config/                 Environment validation primitives
│   ├── ui/                     Accessible presentational primitives
│   ├── testing/                Shared test helpers (a11y assertions)
│   ├── eslint-config/          Flat ESLint configs: base / nest / next
│   └── typescript-config/      Shared tsconfig bases
│
├── docs/
│   ├── adr/                    Architecture Decision Records
│   ├── architecture/           This document and the overview
│   ├── api/                    Error model, versioning, OpenAPI
│   └── operations/             Local development, runbooks
│
├── infrastructure/
│   ├── docker/                 Local development services
│   └── scripts/                Operational scripts
│
└── .github/workflows/          CI quality gates
```

## Dependency rules

```
apps/web ─────► packages/contracts ◄───── apps/api
   │                    ▲                     │
   ├──► packages/ui     │                     ├──► packages/config
   └──► packages/testing└─────────────────────┘
```

Enforced by `package.json` declarations under pnpm's strict, non-flat
`node_modules` layout — a package can only import what it declares.

1. **`apps/*` never import each other.** They communicate over HTTP, using the
   contracts package as the shared definition.
2. **`packages/*` never import from `apps/*`.** The dependency arrow points one
   way. A shared package that reaches into an application is no longer shared.
3. **`packages/contracts` is runtime-neutral.** No Node APIs, no DOM APIs, no
   framework imports — it is bundled into the browser and loaded by the server.
4. **`packages/ui` is presentation only.** No data fetching, no business rules.
   It ships TypeScript source (transpiled by Next) so the design system and the
   app stay in sync without a rebuild loop.

## Why each shared package exists

| Package                               | Exists because                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts`                           | The two apps must agree on every request, response, error code and workflow constant. Defined once, a mismatch is a compile error rather than a production surprise. |
| `config`                              | Both apps validate environment variables and both should fail the same way — listing every problem at once, never echoing a value into a log.                        |
| `ui`                                  | Accessibility decisions (focus rings, status text alongside colour) belong in one place. Re-implemented per component, they get forgotten.                           |
| `testing`                             | An accessibility assertion written slightly differently in each suite tests slightly different things.                                                               |
| `eslint-config` / `typescript-config` | Strictness that can be relaxed per package is not strictness.                                                                                                        |

## Naming and conventions

- Files: `kebab-case.ts`. Nest classes carry their role — `*.module.ts`,
  `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.port.ts`.
- Tests sit beside the code they cover: `*.spec.ts` (API), `*.test.ts(x)` (web
  and packages). Integration tests live in `apps/api/test/` as `*.e2e-spec.ts`.
- Every package exposes the same script names — `build`, `lint`, `typecheck`,
  `test`, `clean` — so `turbo run <task>` works uniformly and CI does not need
  per-package special cases.
