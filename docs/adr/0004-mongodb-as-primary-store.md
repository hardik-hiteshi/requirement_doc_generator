# ADR-0004: MongoDB as the primary data store

## Status

Accepted (Phase 1)

## Context

The brief specifies MongoDB. This ADR records how it will be used, and where the
shape of the data genuinely fits a document store versus where it needs care.

The data divides into three groups:

1. **Document-shaped and naturally nested** — a generated document's structured
   content, an extraction result with its fragments and source references, an AI
   usage record. These are read and written whole, and their shape varies by
   document type.
2. **Relational-ish** — requirement items referencing sources, WBS tasks
   referencing predecessors, client dependencies referencing WBS ids. These have
   real referential structure.
3. **Large binaries** — uploaded PDFs, images, spreadsheets.

## Decision

MongoDB via Mongoose is the primary store, with these rules:

- **Group 1 is stored as nested documents.** This is what the store is good at.
- **Group 2 is stored as separate collections with explicit id references.**
  Embedding a WBS tree inside a project document would make a single-task update
  a whole-document rewrite and put the 16 MB document limit on the critical path
  of a large project. Referential integrity is enforced in the domain layer,
  because the database will not do it.
- **Group 3 never goes in MongoDB.** Binaries go to object storage behind
  `FileStoragePort` (ADR-0005); only metadata and a storage key are persisted.
  GridFS was considered and rejected — it turns the database into a file server
  and complicates backup, retention and signed access.
- **Every collection's indexes are declared with its schema and documented**, in
  the same commit that introduces the collection. An unindexed query on a
  growing collection is a production incident with a delayed fuse.
- **Concurrent document editing uses optimistic concurrency**, via a version
  field checked on update. Last-write-wins would silently discard a reviewer's
  edits.

Connection configuration disables command buffering. With buffering on, a query
issued while the connection is down waits until it times out, turning an outage
into a queue of slow requests and a health check that still reports "ok". Off, it
fails immediately and readiness reports the truth.

## Consequences

- Schema evolution is cheap, which suits a system whose document structures will
  change across phases.
- Cross-collection consistency is the application's job. Operations that must be
  atomic across collections use MongoDB transactions (replica set required in
  production — noted for the deployment phase). **Since then:** no code path opens a
  transaction. Concurrent edits are held apart by a compare-and-set on a version
  field, and the places that touch more than one collection — a purge, an audit entry
  beside the change it records — are ordered so that a failure between them leaves
  something recoverable rather than something wrong. So a standalone `mongod` is a
  supported deployment, which is what CI and the compose stack run, and nothing in
  [deployment](../operations/deployment.md) asks for a replica set. Run one for
  availability if you want one, not to satisfy this line.
- Aggregate reporting across projects will need aggregation pipelines rather than
  joins. Acceptable: the reporting in scope is per-project.
- Because the database does not enforce referential integrity, the domain layer
  must — and the validation phase's cycle detection and cross-document checks are
  where that is verified.

## Alternatives considered

**PostgreSQL.** A better fit for group 2 and for the WBS dependency graph
specifically, with real foreign keys and recursive CTEs. Rejected because the
brief specifies MongoDB, and the mitigation (separate collections, domain-level
integrity, documented indexes) is workable.

**MongoDB with everything embedded in one project document.** Rejected: the
16 MB limit is reachable for a large project with extraction fragments, and every
small edit would rewrite the entire document.

**GridFS for uploads.** Rejected: object storage with signed, authorized reads is
the right tool, and it keeps backup and retention policies for binaries separate
from the database's.
