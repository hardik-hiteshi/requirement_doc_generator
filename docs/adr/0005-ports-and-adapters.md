# ADR-0005: Ports and adapters for external systems

## Status

Accepted (Phase 1)

## Context

Five external capabilities are needed by later phases: an AI provider, object
storage, a job queue, file extraction/OCR, and document export. Each has the same
properties — it is slow, it fails in ways the domain must handle, it is awkward
to run in a unit test, and it is a plausible replacement target (a second AI
provider, local disk versus S3, a different OCR engine).

The default path is to import the vendor SDK directly in the service that needs
it. That is quick, and it is how business logic ends up unable to run without a
network, a credit card, and a specific vendor.

Phase 1 has no business logic to wrap yet — which is exactly why the boundary
should be drawn now. Retrofitting it later means touching every call site.

## Decision

Every outbound capability sits behind a **port**: a TypeScript interface owned by
the application, in `apps/api/src/ports/`, bound through a `Symbol` injection
token.

Rules:

1. **A port describes what the domain needs, not what a vendor offers.** If an
   interface mirrors an SDK's method names, it is an SDK wrapper, not a port.
   `AiProviderPort.runTask()` takes a versioned prompt reference, evidence blocks
   and a response schema — concepts from this product, not from any SDK.
2. **Ports are framework-free.** No `Request`, no Mongoose documents, no Nest
   decorators. This keeps them usable from anywhere and trivial to fake.
3. **Failure modes are part of the contract.** Each port declares a typed error
   with a discriminated reason and, where it matters, a `retryable` flag.
   Adapters translate vendor errors into these. Callers handle a closed set
   instead of guessing at vendor error codes.
4. **No port is bound to an implementation in Phase 1.** An accidental injection
   fails at bootstrap with "no provider" rather than silently resolving to a stub
   that returns plausible fake data.

## Consequences

- Business logic is unit-testable without network, credentials or Docker. Given
  how much of this product is AI orchestration, that is the difference between a
  test suite that runs in seconds and one nobody runs.
- Adding a second AI provider, or swapping local storage for S3, is a new adapter
  plus a binding change.
- Prompt-injection defence has a natural home: `AiTaskRequest` separates trusted
  `instructions` from untrusted `evidence` at the type level, so a caller cannot
  accidentally concatenate an uploaded document into the system prompt.
- Ports cost design effort up front and can leak if written carelessly — an
  interface with a `getRawSdkClient()` escape hatch provides no isolation at all.
  Review should treat such an addition as a defect.
- Five interfaces exist with no implementations. This is deliberate and stated in
  `apps/api/src/ports/README.md`, with the owning phase named for each.

## Alternatives considered

**Import SDKs directly, extract interfaces when a second implementation is
needed.** Rejected: "when needed" arrives as a deadline, and by then the SDK's
types have spread through the domain. The extraction is then a large risky
refactor instead of a design decision.

**One generic `ExternalService` abstraction.** Rejected: an interface general
enough to cover AI calls and file uploads describes neither, and callers end up
casting.

**Ship no-op stub implementations now so the tokens resolve.** Rejected
explicitly: a stub that returns empty results is indistinguishable from a working
adapter with nothing to do, and it invites shipping a feature that appears
complete and does nothing. Failing loudly is the honest behaviour.
