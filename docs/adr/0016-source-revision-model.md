# ADR-0016: Append-only content revisions, with an explicit effective pointer

## Status

Accepted (Phase 3)

## Context

Extraction is often imperfect, especially through OCR, so users must be able to
correct what was read. Correcting a client's requirements is a consequential act:
later phases build a baseline from this content, and that baseline ends up in a
signed document.

Two things therefore have to be true at once. A correction must take effect. And
the original must remain available — so a mistaken correction is recoverable, and
so anyone can see what the file actually said versus what somebody typed.

## Decision

**Revisions are immutable documents in their own collection. Nothing is ever
updated in place.**

- Revision 0 is what the extractor produced.
- Every correction appends a new revision.
- "Restore the original" appends a revision that copies revision 0 — it is a
  pointer move, not a rollback, so the mistaken correction stays in the history.
- The source record holds `currentRevision`, which names the **effective**
  content.

That field is called `effectiveContent` in the API, not `content`. The naming is
load-bearing: a caller reaching for "the content" must not silently receive the
unreviewed original, and a name that invites the question is worth the extra word.

Content lives in `extracted_content` rather than on the source document for two
reasons. A 500-page PDF produces tens of thousands of blocks, which would push a
source towards MongoDB's 16 MB limit; and long before that, _listing_ a project's
sources would load every block of every one of them, because a projection cannot
exclude what it must read off disk first. The list view is the most frequent
query in this phase.

Corrected blocks are set to confidence 1. A human read the text and typed what it
says; continuing to flag it as uncertain would keep drawing a reviewer back to
something already fixed.

Editing a source clears its reviewed status. The reviewer approved different
words, and letting an approval carry across an edit would attribute a sign-off
nobody gave.

## Consequences

- Storage grows with corrections. Bounded in practice — corrections are per
  block, and the number of review passes over one source is small — and the
  retention job in Phase 12 is where old revisions would be pruned if it ever
  mattered.
- "Restore" is a read, so it cannot fail halfway and leave content in a state
  that is neither the original nor the correction.
- The revision list is a genuine audit record rather than a changelog someone has
  to trust, because no document in it can be edited after it is written.
- A re-extraction (after a retry) **deletes** the revision history and starts
  again at revision 0. This is deliberate: the previous revisions describe content
  that no longer exists, and keeping them would let "restore the original" bring
  back text from a different reading of the file.

## Alternatives considered

**Update the content in place and keep a separate diff log.** Rejected: the log
would be the only record of the original, and a bug in writing it would lose the
thing that makes correction safe.

**Store revisions as an array on the source document.** Rejected: appending to a
subdocument array rewrites the whole array, and it puts unbounded content back on
the document the list query reads.

**Let corrections mark blocks "verified" rather than replace them.** Rejected as
insufficient: OCR does not only miss confidence, it produces wrong words, and a
reviewer needs to fix the text rather than bless it.
