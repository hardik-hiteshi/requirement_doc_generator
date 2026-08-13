# 40. A version per content change, and identity that survives it

Date: 2026-08-12

Status: Accepted

## Context

Phases 7 to 9 versioned a document when it was generated, restored, revised or reopened.
An ordinary edit — a section reworded, a row corrected, a proposal accepted — mutated the
working version in place and then re-archived it under the same version number.

That is cheaper, and it is wrong in a way that only shows up when somebody needs the
history. Re-archiving overwrote the snapshot a reader had already been shown. There was
nothing to compare an edit against, because both sides of the comparison were the same
version. And a version could not say why it existed: `changeType` written at the moment
of the change would immediately be overwritten by the next touch of the same version.

Approval made it worse. Reopening an approved document flipped its status in place, so
the archived row for v5 stopped saying APPROVED the moment somebody edited it — and its
`approvedAt` was cleared. The history could no longer answer "which version did we
approve, and when?", which is most of what a history is for.

The obvious fix — cut a version for every mutation — has a cost that is not obvious. Row
and section ids were globally unique, so copying content to a new version meant minting
new ids for all of it. That breaks every caller holding an id: an open editor, a
multi-step flow like request → receive → check on a client dependency, and any
comparison trying to match a row to its predecessor.

## Decision

**Every content change cuts a new version.** Done once, in `afterContentChange`, rather
than in each of the dozen mutation paths: the content is read back after the mutation and
re-keyed to the next version, and the version it came from keeps the snapshot it was
archived with. A read, a comparison or a history listing creates nothing.

**Identity survives the version.** `sectionId`, `featureId` and `rowId` are unique
_within_ a version rather than globally, and a mutation carries them forward. So an open
editor still refers to the same section, a dependency lifecycle works on one row id
throughout, and a comparison can match rows that moved. Every id lookup is scoped by
version — without that, an unscoped query matches every version that ever held the row
and returns whichever the index yields first.

**Reopening cuts a working version instead of reclassifying the approved one.** v5 stays
APPROVED with its `approvedAt`, immutable, and work continues on v6. This is the same
shape as revising an issued document; the only difference is which status the preserved
version carries.

**A version records why it exists.** `changeType`, `restoredFromVersion`,
`revisedFromVersion` and `actor`, written at the moment of the change and never
overwritten by a later touch. A diff cannot distinguish "restored from version 4" from
"edited to match version 4", and the history is the only place that distinction survives.

**`actor` is `USER` or `SYSTEM`, not a name.** Projects here are anonymous by design;
anything more specific would be either empty or invented.

## Consequences

A document accumulates versions quickly — one per edit, not one per session. That is the
point, and it makes the history longer than a list somebody would have designed by hand.
The interface answers it by saying what each version _is_ rather than only when it was:
an edit, a rewrite, an approval, content brought back from an earlier version.

Three defects surfaced while making this work, each invisible until versions were real:

Historical versions read back with **no rows at all**. The snapshot mapper took rows only
from assembled extras and ignored stored content, so four of the seven documents had an
unreadable history and an empty comparison — while appearing to work.

The version bump reused a `recordVersion` that some callers had already incremented. The
update silently matched nothing while the content was re-keyed anyway, so the record went
on pointing at a version holding no rows: **the document lost its content.** It now
re-reads and fails loudly on a genuine conflict.

And Mongoose's default `minimize` stripped `effort: {}` from a stored payload, so a
hand-added task with no hours came back missing the field and every subsequent read threw.

The last two are the argument for this change rather than against it. Both were latent
before; versioning every mutation is what exercised the paths that exposed them.
