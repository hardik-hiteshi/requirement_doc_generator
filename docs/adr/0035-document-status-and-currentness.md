# 35. Lifecycle status and currentness are two axes

Date: 2026-08-11

Status: Accepted

Amends [ADR-0033](0033-shared-document-engine.md).

## Context

A controlled document carries two unrelated facts.

The first is **what people decided about it**: nothing yet, a draft, changes wanted,
agreed, issued. Every value is the result of somebody doing something.

The second is **whether the world has moved since it was written**: the requirements
were re-approved, the stack was unlocked, the estimate changed, a document it was
built on was reopened. Nobody chooses this. It is derived by comparing the upstream
versions the content was written against with the versions that are authoritative
now.

Phase 7 shipped these as one enum, with `OUTDATED` sitting alongside `DRAFT`,
`APPROVED` and `FINAL`. That worked until an issued document went stale, at which
point the model could express only two things, and both of them were false:

- **relabel it `OUTDATED`.** The document was issued. A record that stops saying so
  cannot answer "which version did the client receive?", which is the entire reason
  `FINAL` exists.
- **leave it `FINAL` and say nothing.** Then a document the project has moved past
  looks identical to one that is current, and somebody quotes it.

Phase 7 chose the second and documented the choice. It was the better of two bad
options, and it meant issued documents silently stopped reporting upstream changes —
the one class of document where "the project has changed since this was sent" most
needs saying.

The single axis was also leaking into the engine. An approved document whose inputs
had moved was _reported_ as `OUTDATED` but _stored_ as `APPROVED`, so every check
had to decide which one it meant. Regeneration had to synthesise a fake `OUTDATED`
status to get past its own transition table, because `APPROVED` could not reach
`QUEUED` — a special case invented to work around a model that could not say what
was true.

## Decision

**Two fields.**

`status` is the lifecycle: `NOT_STARTED`, `QUEUED`, `GENERATING`, `DRAFT`,
`NEEDS_REVISION`, `APPROVED`, `FINAL`, `FAILED`. Eight values, each one something a
person did. There is no `OUTDATED`.

`currentness` is `CURRENT` or `OUTDATED`. Derived on every read, never stored as
truth, never set by a user, computed by one shared function so the list view and the
detail view cannot disagree.

An issued document that has gone stale is `FINAL` + `OUTDATED`, and reads on screen
as **Issued · Out of date**. It keeps its content byte for byte, keeps the upstream
versions it was written against, keeps its place in history, and stays immutable.
The only thing that changed is what the application says about it.

**Currentness governs permission; status governs the transition.** Approving and
issuing require `CURRENT`; editing and regenerating depend only on status. So an
approved-but-stale document is still editable and still regenerable — which is
exactly what the screen advises — while nothing stale can be approved or issued.

**Currentness propagates transitively and changes nothing.** A prerequisite that
moves marks every document downstream of it, along the whole seven-document chain,
with a reason and nothing else: no content rewritten, no status touched, no version
created. Regenerating against the new version is what clears it. Re-approving the
prerequisite is deliberately _not_ enough — this document was written against the
version before, and nobody has read it since.

## Consequences

Special cases disappeared rather than accumulating. `canGenerateDocument('APPROVED')`
is now simply true; the synthesised status is gone; `markDependentsOutdated` no
longer writes a status, and no longer has to skip issued documents to protect them.

`isAuthoritativeState` asks for both axes, so an approved prerequisite whose own
inputs moved does not unlock the document after it. Staleness cannot travel down the
chain unannounced.

Versions in the history carry their own currentness, judged from the upstream
versions recorded with each one. The history can state that the version issued in
March is no longer current without anything in the March document changing.

Revising an issued document re-stamps the new working version against today's
authority and clears its validation. The text was carried across unread, so the
cleared validation is what stops it being presented as agreed — approval needs a
fresh one, whose coverage and citation checks run against the current baseline. If
the baseline itself has not been re-approved, the new working version reports itself
out of date too. Revising opens a version to work in; it does not launder staleness.

The cost is one more field on the snapshot, the summary and every version row, and
two labels on screen where there was one. That is the correct price: the alternative
was a document that could not describe its own situation.
