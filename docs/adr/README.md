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

| ADR                                                 | Title                                                    | Status   |
| --------------------------------------------------- | -------------------------------------------------------- | -------- |
| [0001](0001-monorepo-with-pnpm-and-turborepo.md)    | Monorepo with pnpm workspaces and Turborepo              | Accepted |
| [0002](0002-modular-monolith.md)                    | Modular monolith over microservices                      | Accepted |
| [0003](0003-typescript-version-pinning.md)          | Pin TypeScript 5.9 rather than adopt 7.x                 | Accepted |
| [0004](0004-mongodb-as-primary-store.md)            | MongoDB as the primary data store                        | Accepted |
| [0005](0005-ports-and-adapters.md)                  | Ports and adapters for external systems                  | Accepted |
| [0006](0006-api-error-model-and-correlation-ids.md) | Single API error envelope with correlation ids           | Accepted |
| [0007](0007-zod-as-single-schema-language.md)       | Zod as the single schema language                        | Accepted |
| [0008](0008-test-strategy-and-runners.md)           | Layered test strategy with two runners                   | Accepted |
| [0009](0009-request-validation-and-mapping.md)      | Request validation and explicit mapping                  | Accepted |
| [0010](0010-anonymous-project-access.md)            | Anonymous project access and stateless session           | Accepted |
| [0011](0011-file-storage-provider.md)               | Filesystem storage now, S3 behind the port               | Accepted |
| [0012](0012-job-queue-provider.md)                  | A MongoDB job queue rather than Redis                    | Accepted |
| [0013](0013-extraction-libraries.md)                | One extractor per format, behind a registry              | Accepted |
| [0014](0014-ocr-provider.md)                        | Tesseract as a local binary, behind a port               | Accepted |
| [0015](0015-legacy-file-strategy.md)                | A conversion boundary for .doc and .xls                  | Accepted |
| [0016](0016-source-revision-model.md)               | Append-only content revisions                            | Accepted |
| [0017](0017-self-hosted-ai-inference.md)            | Self-hosted inference, never a model vendor              | Accepted |
| [0018](0018-model-profile-strategy.md)              | Model profiles as data, not a hardcoded choice           | Accepted |
| [0019](0019-prompt-versioning.md)                   | Versioned, registered, checksummed prompts               | Accepted |
| [0020](0020-structured-output-repair.md)            | Bounded repair; never persist unvalidated output         | Accepted |
| [0021](0021-inference-endpoint-hardening.md)        | Connect to a validated address, not to a name            | Accepted |
| [0022](0022-chunking-and-reconciliation.md)         | Chunk, then reconcile across the chunks                  | Accepted |
| [0023](0023-two-confidences.md)                     | Two confidences; only evidence governs                   | Accepted |
| [0024](0024-baseline-lifecycle.md)                  | The baseline earns its numbers; versions supersede       | Accepted |
| [0025](0025-clarification-integration.md)           | A confirmed clarification is evidence, not an assumption | Accepted |
