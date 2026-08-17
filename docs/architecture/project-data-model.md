# Project data model

> Phase 2–3. Five collections: `projects`, `audit_events`,
> `requirement_sources`, `extracted_content` and `extraction_jobs`.
>
> The last three are described in
> [requirement ingestion](requirement-ingestion.md), which is where their
> relationships and indexes belong.

## `projects`

| Field                                                        | Type        | Notes                                                                                                                          |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `_id`                                                        | ObjectId    | **Never exposed.** Not the public handle — see ADR-0010.                                                                       |
| `projectId`                                                  | string      | Public identifier, `prj_` + 26 base32 chars. Unique.                                                                           |
| `secretHash`                                                 | subdocument | `{algorithm, version, salt, hash}`. `select: false`, so it is only loaded by the one repository method that verifies a secret. |
| `status`                                                     | enum        | `DRAFT` \| `ACTIVE` \| `EXPIRED` \| `DELETION_PENDING` \| `DELETED`                                                            |
| `version`                                                    | number      | Optimistic-concurrency counter. Distinct from Mongoose's `__v`.                                                                |
| `schemaVersion`                                              | number      | Document layout version, so a future migration can find records.                                                               |
| `name`                                                       | string      | Required.                                                                                                                      |
| `clientName`, `internalReference`, `description`             | string?     | Optional. Cleared with `$unset`, not set to null.                                                                              |
| `projectTypes`                                               | string[]?   | Collected in Phase 2; consumed by Phases 5–9.                                                                                  |
| `timeline`, `startDate`, `teamCapacity`, `outputPreferences` | object?     | Structured sections, validated by the Zod contract at the boundary.                                                            |
| `lastAccessedAt`                                             | Date        | Updated on read and write.                                                                                                     |
| `expiresAt`                                                  | Date        | Expiry instant.                                                                                                                |
| `deletionRequestedAt`, `deletedAt`                           | Date?       | Soft-deletion metadata.                                                                                                        |
| `createdAt`, `updatedAt`                                     | Date        | Managed by Mongoose.                                                                                                           |

### Why structured sections are stored as plain objects

Mirroring the discriminated unions (`Timeline`, `StartDate`) in a Mongoose schema
would restate every rule in a second language and let the two definitions drift.
The Zod contract is the single source of truth: sections are validated on the way
in, and re-parsed on the way out so a response never carries a shape the
published contract does not describe.

### Indexes

| Index                       | Purpose                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `{projectId: 1}` unique     | The lookup on every authenticated request; enforces identifier uniqueness. |
| `{status: 1, expiresAt: 1}` | The query the expiry sweep will run.                                       |

### No TTL index — deliberately

A TTL index on `expiresAt` would delete documents outright. That would:

- erase the subject of the audit trail, leaving events pointing at nothing;
- skip `DELETION_PENDING` entirely, so the lifecycle the application enforces and
  the lifecycle the database performs would disagree;
- silently discard data a user can still legitimately read — an expired project
  is readable, just not editable.

Expiry here means "no longer usable", not "gone". The transition to `DELETED` and any
physical removal belong to the retention job added in Phase 12, which defines the
retention period and what survives it — see [retention](../operations/retention.md).
Where retention is disabled, a project stays in `DELETION_PENDING`, which is already
terminal from the user's point of view.

## `audit_events`

| Field           | Type    | Notes                                                                           |
| --------------- | ------- | ------------------------------------------------------------------------------- |
| `type`          | enum    | One of the twelve audit event types.                                            |
| `projectId`     | string? | Public id. Nullable — a failed recovery may name a project that does not exist. |
| `correlationId` | string? | Ties the event to the request's log lines.                                      |
| `reason`        | string? | Internal reason code. **Never mirrored into an API response.**                  |
| `metadata`      | object? | Event-specific. Sanitised on write.                                             |
| `occurredAt`    | Date    | Managed by Mongoose.                                                            |

Indexes: `{projectId: 1, occurredAt: -1}` and `{type: 1, occurredAt: -1}` — the
two questions actually asked of this collection.

**Nothing secret reaches this collection.** The audit service redacts by key name
and by value shape, so a recovery secret filed under an innocuous key is caught
as well as one under an obvious one.

## Lifecycle

```
        create
          │
          ▼
     ┌────────┐   first edit    ┌────────┐
     │ DRAFT  │ ──────────────▶ │ ACTIVE │
     └───┬────┘                 └───┬────┘
         │      expiry passes       │
         └──────────┬───────────────┘
                    ▼
              ┌───────────┐
              │  EXPIRED  │   readable, not editable
              └─────┬─────┘
                    │
   delete requested (from DRAFT, ACTIVE or EXPIRED)
                    ▼
        ┌────────────────────┐   retention job (Phase 12)   ┌─────────┐
        │ DELETION_PENDING   │ ───────────────────────────▶ │ DELETED │
        └────────────────────┘                              └─────────┘
```

Expiry is derived on access rather than swept by a job: with no scheduler in this
phase, a stored status would go stale the moment the timestamp passed. One
function, `effectiveStatus`, is the single answer to "what is this project's
status right now".

`DELETED` is terminal — no transition leads out of it.

## Access rules

| Status             | Readable                                  | Editable |
| ------------------ | ----------------------------------------- | -------- |
| `DRAFT`            | yes                                       | yes      |
| `ACTIVE`           | yes                                       | yes      |
| `EXPIRED`          | yes — so the user can copy their work out | no       |
| `DELETION_PENDING` | no                                        | no       |
| `DELETED`          | no                                        | no       |

## Optimistic concurrency

Every section update sends the `version` the client last read. The repository
puts that version in the **query filter**, so the check and the write are a
single atomic operation:

```ts
findOneAndUpdate({ projectId, version: expectedVersion }, { $set: …, $inc: { version: 1 } })
```

A `null` result means someone else saved first. Reading, comparing in application
code, then writing would leave a window in which a concurrent save is silently
lost — which is exactly the failure this is meant to prevent.
