# Retention: what stops being kept, and when

A project accumulates client material — pasted requirements, uploaded briefs, generated
documents, an estimate. Keeping all of it for ever is a choice, and for most deployments
the wrong one: the files are somebody else's commercial information, and an installation
that never removes anything is one whose oldest data nobody can account for.

Two separate clocks, because "unusable" and "gone" are different promises.

## 1. Expiry — already enforced, now also recorded

A project past `expiresAt` reads as `EXPIRED` and refuses writes. That has always been
true and does not depend on this job: `effectiveStatus` derives it on every access, so
there is no window in which an expired project accepts changes.

What the sweep adds is that the **stored** status catches up. Before, the record still said
`ACTIVE` for a project the application had long since frozen, so anyone querying the
database directly — an operator, a report, a backup audit — saw something untrue.

An expired project is still readable. Somebody who let a project lapse can see what they
had and copy it out; they cannot change it.

## 2. Purging — content removed, after a visible pending state

```
delete requested          retention window
   or abandoned    ────▶  DELETION_PENDING  ────▶  DELETED
                                                   (content gone)
```

Nothing skips a step. An expired project is never purged directly: it is first **queued**,
entering the same pending state a requested deletion does. That window is what makes a
deletion observable before it becomes irreversible, and it is where an operator can
intervene.

### What a purge removes

Every collection holding project content — requirements, analysis, stack, estimates,
documents, rows, versions, runs — and the project's objects in file storage.

### What a purge keeps

The **project record**, moved to `DELETED`, and its **audit trail**.

This is deliberate. A deletion that could not be accounted for afterwards is not a better
deletion, and afterwards is exactly when somebody asks what happened. The record survives
so its trail still has a subject.

### Why there is no TTL index

MongoDB's TTL index would delete the project document outright on `expiresAt`. That erases
the subject of its own audit trail and skips `DELETION_PENDING` entirely — no pending
state, no window, no record that anything was ever there. The project schema records this
decision where the index would otherwise be added.

## Safety properties

- **Only from the pending state.** `isPurgeEligible` returns false for every other status.
- **A missing timestamp means wait.** A pending project with no `deletionRequestedAt`
  predates that field; it is treated as not yet eligible rather than infinitely old,
  because the safe reading of missing data about a destructive operation is "wait".
- **Claimed by conditional update.** Each transition matches on the status it expects, so
  two sweeps cannot both purge the same project and a project somebody changed between the
  query and the update is not dragged back to a stale state.
- **Batched.** `RETENTION_BATCH_SIZE` projects per pass, so one tick cannot monopolise the
  database.
- **Content first, status last.** A failure part-way leaves the project
  `DELETION_PENDING`, which is the state that gets retried. Marking it deleted first would
  abandon files nothing would ever look for again.
- **Storage failure does not block.** If the database content is gone but the storage
  prefix could not be removed, the project still completes and the orphaned prefix is
  logged. A project stuck in a retry loop is the bigger problem.
- **Audited.** `PROJECT_QUEUED_FOR_DELETION`, `PROJECT_PURGED` and
  `RETENTION_SWEEP_COMPLETED` carry counts — never content, never which files.

A sweep that did nothing writes nothing. An hourly "nothing to do" would bury the events
that matter.

## Configuration

| Variable                        | Default | Meaning                       |
| ------------------------------- | ------- | ----------------------------- |
| `RETENTION_ENABLED`             | `false` | Whether the sweep runs at all |
| `RETENTION_SWEEP_INTERVAL_MS`   | 3600000 | How often it looks for work   |
| `RETENTION_DELETION_GRACE_DAYS` | 7       | Pending → purged              |
| `RETENTION_EXPIRED_GRACE_DAYS`  | 90      | Expired → queued for deletion |
| `RETENTION_BATCH_SIZE`          | 25      | Projects per pass             |

**Off by default.** Retention deletes data, and a default that quietly removed things from
a machine somebody was using to evaluate the product would be indefensible. A deployment
turns it on having chosen its windows.

Production startup **warns** when it is off — it logs the consequence and carries on. That
is deliberate: a forgeable session secret is _wrong_ and stops the process, while keeping
every project for ever is a _decision_ some deployments are contractually required to make,
and refusing to boot over a lawful data policy would be the tool overruling its operator.

It does **refuse** `RETENTION_DELETION_GRACE_DAYS=0` when retention is on, which would make
a deletion irreversible the moment it was requested and remove the point of the pending
state.

## Running one by hand

With the operator surface enabled:

```
curl -X POST https://your-host/api/v1/admin/retention/run \
  -H "x-admin-token: $ADMIN_API_TOKEN"
```

It does exactly what the timer does, and cannot purge anything the configured policy would
not have purged on its own — so the worst it can do is make scheduled work happen sooner.
Useful after changing a window, when waiting an hour to see the effect is not helpful.

## The first sweep waits

The worker's first pass happens one interval after boot, not at startup. Startup is when a
deployment is least able to absorb a burst of deletes, and nothing here is urgent:
everything eligible now was eligible an hour ago.
