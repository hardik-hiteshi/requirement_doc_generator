# ADR-0024: The baseline earns its numbers, and versions supersede

## Status

Accepted (Phase 4)

## Context

A requirement baseline is what a client signs. Everything else in this phase
exists to make that document trustworthy, and three questions decide whether it
is:

- **How complete is it, really?** A generation that finished successfully is not
  the same as a document that covers the input.
- **When may it be approved?** "The reviewer should have noticed" is not a
  control.
- **What happens when the documents change afterwards?** An approved baseline
  whose sources have moved on is a document that says something no longer true,
  and quietly rewriting it would be worse than leaving it.

## Decision

### Numbers are recomputed, never patched

Coverage, alignment and the blocker list are calculated from stored records
every time anything changes. An incrementally-maintained completeness figure is
one missed update away from being a confident lie, and this one appears next to
_Approve_.

**Coverage** is counted in _evidence blocks that received a disposition_, not in
requirements found — a model that splits one sentence into four has not covered
more of the document. A block whose chunk failed is `not_analysed` and counts
against coverage; a block with no record at all is counted the same way, because
a missing record is exactly the case the number exists to catch.

### Alignment is capped while anything is unresolved

Four components — traceability, evidence quality, finding resolution,
clarification resolution — combined and then **capped at 0.85 while
`isComplete` is false**. It is false while any of these holds: a block was never
analysed, an item cannot be traced to a verified quotation, a blocking conflict
is open, a blocking question is unanswered.

The cap matters more than the score. A number near 100 beside six unresolved
conflicts is not an optimistic estimate; it is a false statement in a document a
client is being asked to trust. `incompleteReasons` carries the explanation in
plain language, and the UI shows it rather than the bare percentage.

### Approval is gated by an enumerated list

Nine blocker kinds, each computed from stored data, each naming **what is wrong
and what to do about it**, each carrying the ids of the affected records so the
interface can link to them. Approval with any present is refused with 422 and
the blocker list in the response — and the blockers are recomputed immediately
before the check, because a browser's view may be minutes old and this is the
one operation where acting on a stale view outlives the session.

Approval also requires an explicit acknowledgement (`acknowledgedAiAssistance`),
deliberately not defaulted. A small self-hosted model drafted this; the person
approving has to affirm they read it, because the application cannot check that
for them.

### Versions supersede; nothing is overwritten

A baseline stores the item _ids_ it contains rather than the items, and the
coverage and alignment figures calculated at the time. A later edit to a
requirement therefore cannot retroactively change what an approved baseline
says.

**Outdating is detected by digest.** Each baseline stores a SHA-256 over every
reviewed source's id, revision and block text. Comparing the project's current
digest against it answers "have the sources moved on?" in one string comparison
— no re-reading, no heuristic about what counts as a meaningful change. Anything
that would alter the analysis alters the digest.

An approved baseline whose digest no longer matches becomes `outdated`. **Not a
single requirement changes.** It still says exactly what it said when it was
approved; only the world around it moved, and the status records that. A new
analysis produces a new version, and the old one stays readable.

### Re-analysis proposes; it does not overwrite

`editedByUser` is set the first time a person changes an item and is never
cleared. A later run carries edited and accepted items forward by their
normalised statement, keeping the human wording. The model may find better
evidence, and that is taken; it does not get to rewrite a sentence somebody
chose.

## Consequences

**Good.** Every claim the baseline makes about itself is derived from records
that can be inspected, and every refusal to approve names its own remedy.

**Cost.** Full recalculation on every mutation, and a digest over every block on
every baseline read. Both are milliseconds against inference measured in
minutes.

**A project can be stuck.** A model that produced an untraceable requirement
leaves a blocker only a person can clear — by checking it against the source and
rejecting it. That is the intended outcome: the alternative is approving a
requirement nobody can check.

**Outdated is a status, not a repair.** The application does not attempt to
merge new source content into an approved baseline. It says the baseline is out
of date and offers a new analysis, because an automatic merge would silently
change a document somebody signed.
