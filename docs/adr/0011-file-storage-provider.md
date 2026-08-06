# ADR-0011: Local filesystem storage now, S3 behind the same port later

## Status

Accepted (Phase 3)

## Context

Uploaded requirement documents are a client's commercially sensitive material.
They must be stored privately, retrievable only by the project that owns them,
and removable when that project is deleted.

The brief asks for two adapters: a local filesystem one for development and an
S3-compatible one for production. There is, as of this phase, no deployment — no
bucket, no credentials, no environment to test against.

## Decision

**Implement the filesystem adapter. Do not implement S3 in this phase.**

The port (`FileStoragePort`) is unchanged and complete: `put`, `getStream`,
`head`, `exists`, `createSignedDownload`, `delete`, `deleteProject`. Application
code depends only on the token, never on the class, so adding an S3 adapter is a
new file and one line in the module — not an edit spread across the codebase.

Three properties of the filesystem adapter carry over to any future adapter,
because they are properties of the design rather than of the storage:

- **Paths are built only from application-minted identifiers** — the project id
  and a random object id. A client filename never participates in a path, so
  traversal has nowhere to go.
- **Nothing is web-served.** The storage root is outside every static directory.
  The only route to a file is an API endpoint that checks the session first.
- **`createSignedDownload` returns an API URL**, not a signed one. A filesystem
  has nothing to sign with, and a second authorization mechanism would have to be
  kept in step with the session guard forever.

## Consequences

- Phase 3 runs on a single machine's disk. Horizontal scaling needs the S3
  adapter first, and that is stated rather than implied.
- The download route is the same code path in development and production, so the
  authorization behaviour cannot differ between them.
- **Acceptance criterion §7 is only partly met**, and the completion report says
  so. An untested storage backend is worse than an absent one: it would look like
  a working feature and fail on the day it was first genuinely used.

## Alternatives considered

**Write the S3 adapter and leave it untested.** Rejected. Storage is where data
loss lives, and an adapter exercised by nothing is an assertion, not a feature.
It would also have to be reported as NOT VERIFIED, which is a worse outcome than
a clearly scoped absence.

**Write the S3 adapter and test it against MinIO in CI.** A genuinely good
option, and the one to take when deployment work starts. Rejected for this phase
only because it adds a service container and ~90 seconds to every CI run to test
a path nothing yet uses. The work is a self-contained follow-up.

**Store files in MongoDB with GridFS.** Rejected: it puts binaries in the primary
data store, ties document size to database size, and makes every backup carry
every client's uploads. The brief also explicitly rules it out.
