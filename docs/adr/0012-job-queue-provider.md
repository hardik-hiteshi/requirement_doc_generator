# ADR-0012: A MongoDB-backed job queue rather than Redis and BullMQ

## Status

Accepted (Phase 3)

## Context

Extraction outlives an HTTP request. A 60-page PDF takes seconds; an image needs
an OCR pass. Both must happen after the upload responds, must survive a browser
refresh, and must be retryable.

The obvious choice is BullMQ on Redis. It is mature, well-documented, and gives
scheduling, backoff, dead-lettering and observability for free. It also requires
Redis: a second stateful service in docker-compose, in CI, in every developer's
environment, and in every future deployment.

## Decision

**Implement `JobQueuePort` over a MongoDB collection.**

Claiming is a single `findOneAndUpdate`, which is atomic. That one fact is what
makes the design safe with several workers: two racing for the same job means one
update matches and the other does not, with no lock, no lease renewal, and no
window in which both believe they own it.

The three properties the port promises are each one field:

| Property       | Mechanism                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| Idempotency    | A unique index on `idempotencyKey`, derived from the source and its attempt number — never from a timestamp |
| Resumability   | `stage`, updated as work progresses, so a retry resumes rather than restarts                                |
| Crash recovery | `claimedAt`; a claim older than `EXTRACTION_CLAIM_TIMEOUT_MS` is reclaimable                                |

Workers poll. One indexed query per interval per worker is nothing at this
workload, and polling removes the failure mode where a missed notification
strands a job forever.

## Consequences

- No new service. `docker compose up` is still one container, and CI needs no
  extra sidecar for the integration or browser suites.
- Throughput is bounded by polling latency and by MongoDB, not by a purpose-built
  broker. At a handful of extractions per project this is irrelevant; at
  thousands per second it would not be.
- No queue dashboard. Job state is inspectable with a MongoDB query, which is
  adequate for one queue and would not be for twenty.
- The worker runs in the API process. Bounded deliberately: one job at a time, so
  a large PDF cannot starve the event loop, and shutdown drains the job in
  flight. Moving it to its own process is a deployment change, not a rewrite,
  because nothing in the queue or the port assumes co-location.

## Alternatives considered

**BullMQ on Redis.** The right answer at a different scale, and the one to
revisit when there is either more load or a second kind of background work.
Rejected here because the cost — a stateful service everyone must run — is paid
immediately and the benefit is not needed yet.

**A fully in-process queue with no persistence.** Rejected outright: a restart
mid-extraction would lose the job silently, and the user would be left watching a
progress indicator that never finishes.

**`agenda` or another MongoDB queue library.** Rejected: the useful part of this
is roughly one `findOneAndUpdate`, and a dependency would bring a scheduler, a
cron parser and a plugin system for none of it.
