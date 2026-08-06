# Architecture Decision Records

An ADR captures a decision that is expensive to reverse, together with the
context that made it the right call. The point is not ceremony — it is so that
six months from now nobody has to reconstruct the reasoning from the code, and so
that a decision can be revisited deliberately rather than eroded by accident.

## When to write one

Write an ADR when a choice:

- constrains later phases (data store, deployment topology, auth model),
- is hard or expensive to undo,
- rejects an obvious alternative for a non-obvious reason, or
- will otherwise be re-litigated in every code review.

Routine choices — a library for date formatting, a folder name — do not need one.

## Format

Sequentially numbered, `NNNN-short-title.md`, with these sections:

- **Status** — Proposed / Accepted / Superseded by ADR-NNNN
- **Context** — the forces at play, including constraints from the brief
- **Decision** — what was chosen, stated plainly
- **Consequences** — what this makes easy, what it makes hard, what it commits us to
- **Alternatives considered** — and why each was rejected

Never edit an accepted ADR to change its decision. Write a new one that
supersedes it, and update the old one's status. The record of what we used to
think is part of the value.

## Index

| ADR                                                 | Title                                          | Status   |
| --------------------------------------------------- | ---------------------------------------------- | -------- |
| [0001](0001-monorepo-with-pnpm-and-turborepo.md)    | Monorepo with pnpm workspaces and Turborepo    | Accepted |
| [0002](0002-modular-monolith.md)                    | Modular monolith over microservices            | Accepted |
| [0003](0003-typescript-version-pinning.md)          | Pin TypeScript 5.9 rather than adopt 7.x       | Accepted |
| [0004](0004-mongodb-as-primary-store.md)            | MongoDB as the primary data store              | Accepted |
| [0005](0005-ports-and-adapters.md)                  | Ports and adapters for external systems        | Accepted |
| [0006](0006-api-error-model-and-correlation-ids.md) | Single API error envelope with correlation ids | Accepted |
| [0007](0007-zod-as-single-schema-language.md)       | Zod as the single schema language              | Accepted |
| [0008](0008-test-strategy-and-runners.md)           | Layered test strategy with two runners         | Accepted |
