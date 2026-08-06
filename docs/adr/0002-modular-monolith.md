# ADR-0002: Modular monolith over microservices

## Status

Accepted (Phase 1)

## Context

The API will grow to roughly twenty modules: projects, uploads, extraction, OCR,
analysis, clarifications, baseline, stack, estimation, timeline, seven document
types, versioning, approval, exports, audit, AI orchestration, usage tracking,
retention.

That list reads like a service catalogue, and the temptation is to build it as
one. But the modules are not independent: document generation reads the approved
baseline, the locked stack and the approved estimate; approving an upstream
document invalidates downstream ones. Almost every interesting operation spans
several modules and must be consistent.

There is also no known load profile yet. The application has no users.

## Decision

A **modular monolith**: one deployable NestJS application composed of feature
modules with explicit boundaries.

Boundaries are enforced by structure rather than by network calls:

- Each feature owns a directory with its module, services, repositories and
  schemas.
- Cross-feature access goes through an injected service, never by reaching into
  another feature's repository or Mongoose model.
- Everything that leaves the process — AI provider, object storage, job queue,
  extraction, export — sits behind a port (see ADR-0005), which is where a
  service boundary could later be introduced without touching business logic.

Background work is asynchronous from the start, via the job queue port. That is
the part of "distributed" this product genuinely needs, and it does not require
splitting the deployable.

## Consequences

- A workflow that spans modules can use a single database transaction and stay
  consistent, instead of needing sagas and compensating actions.
- Local development is one process plus MongoDB. A new contributor is productive
  the same day.
- Refactoring across module boundaries is a compiler-checked rename rather than a
  coordinated multi-service release. During phases that reshape the domain, this
  is worth a great deal.
- The whole application scales as a unit. If AI generation later needs to scale
  independently of HTTP serving, the job queue port is the seam to split on —
  the workers already run detached from the request path.
- Module boundaries need active maintenance. Nothing at the language level stops
  one service importing another's internals; code review has to.

## Alternatives considered

**Microservices from the start.** Rejected. It would buy distributed
transactions, network partitions, service discovery, distributed tracing as a
prerequisite rather than an improvement, and a deployment story for twenty
services — all before the first user. The brief explicitly calls for no premature
microservices, and the coupling between these particular modules is high enough
that the split would fight the domain.

**A single unstructured application.** Rejected. Without module boundaries this
codebase reaches the size where every change touches everything. The structure is
cheap to impose now and expensive to retrofit.

**Serverless functions per operation.** Rejected: multi-minute extraction, OCR
and AI generation fit badly into function timeouts, and per-invocation cold
starts would sit directly in a user-facing workflow.
