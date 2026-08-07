# 29. Locking is separate from approval, and it is what later phases read

Date: 2026-08-07

Status: Accepted

## Context

Phase 6 prices work. Phases 7–9 write documents a client signs. All of them need
to know which technologies are being used, and the failure mode if they each
decide for themselves is slow and expensive: the estimate assumes PostgreSQL,
the Statement of Work says MySQL because a model preferred it that day, and
nobody notices until delivery.

Phase 4 solved the equivalent problem for requirements with an approved
baseline. But a baseline and a stack are not the same kind of commitment. An
approved baseline is a statement about _what the client asked for_, which a
later analysis may legitimately revise. A locked stack is a statement about
_what will be built_, and something downstream is about to put a number on it.

## Decision

**Two acts, not one.** Approving says _these are the right technologies_.
Locking says _build and price exactly this_. They are separate buttons with
separate acknowledgements, and `canLockStack` requires `APPROVED`. Collapsing
them would mean an estimate built on a stack nobody meant to commit to — a
person clicks approve to record progress, and discovers later that they signed
something.

**A locked stack emits a contract.** `DownstreamAuthority` is a flat, immutable
record: the technologies with their authority and provenance, the requirement
ids behind each, the acknowledged risks the user kept, and — importantly — the
categories deliberately left empty, with a reason. `isAuthoritative` is the
single gate a downstream phase checks. `GET /stack/authority` refuses anything
not locked.

**Empty means empty.** `technologyFor` returns nothing for a category with no
technology, and there is deliberately no defaulting parameter. A downstream
phase that finds no cache must read "there is no cache", never "pick one".
`excludedCategories` states it explicitly so the absence cannot be mistaken for
an oversight.

**No phase after this one substitutes a technology.** Not to fill a gap, not to
resolve an inconsistency, not on a model's advice. A gap in a locked stack is a
gap in the plan, and the answer is to reopen the stack.

**Reopening supersedes rather than edits.** Unlocking creates a _new version_
with the components carried forward and the lock state deliberately not
inherited. The locked version keeps saying exactly what it said, because that is
what was committed to and what an existing estimate was built on. The user is
asked why, because a change nobody explained is one nobody can review.

**Outdating is detected, never acted on.** The stack stores the baseline version
and the project types as they stood when it was made, and compares them on every
read. A newer baseline, a baseline gone out of date, or a changed project type
produces a blocker — and nothing else. The stack is not regenerated, no
suggestion is re-run, no technology moves. The user decides whether to revalidate,
re-ask for the affected categories, or keep what they have.

That last point required a fix during implementation: the stack originally read
the baseline collection directly and so never triggered Phase 4's lazy
outdated check, which meant it went on believing its requirements were current
long after a document changed. It now reads through `BaselineService`.

## Consequences

There is a step people will forget. A stack sitting at `APPROVED` blocks Phase 6
with a message explaining why, which is the right kind of friction: the
alternative is an estimate built on something that was still being edited.

Reopening a locked stack invalidates work downstream. That is stated on the
screen before the user confirms, and it is the honest consequence of having made
the lock mean something.
