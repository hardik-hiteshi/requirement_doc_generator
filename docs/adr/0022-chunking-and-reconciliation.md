# ADR-0022: Chunk, then reconcile across the chunks

## Status

Accepted (Phase 4)

## Context

A 7B model with an 8k context cannot hold forty pages of requirements. Neither
can a 3B one, and a deployment that can run neither is not the deployment this
product is for. So the content has to be split.

Splitting is the easy half. The hard half is that **three kinds of truth are
invisible to every chunk individually**:

- the same requirement extracted twice, from two chunks of the same document;
- the same requirement stated in two different documents, by two authors who may
  or may not have meant the same thing;
- a requirement asserted in file A and contradicted in file B.

Chunk-local analysis finds none of them. Worse, it produces output that _looks_
complete: two hundred requirements, no conflicts reported, because no chunk
contained a conflict. That is not a smaller answer — it is a confidently wrong
one, and it is the failure mode a naive "just chunk it" implementation ships
with.

## Decision

**Chunk with hard boundaries, analyse each chunk independently, then reconcile
across all of them before anything is stored.**

### Chunking

1. **A chunk never crosses a source.** Two documents in one chunk makes "which
   file did this come from" a question about the model's attention rather than
   about the data, and traceability is the one thing that cannot be approximate.

2. **Boundaries follow the document's own structure.** A chunk ends at a heading
   where it can, because a heading is where the author changed subject.

3. **Nothing is ever silently truncated.** A block bigger than one chunk is split
   at sentence boundaries into parts that are _all_ analysed, and the split is
   recorded. Dropping a tail would report complete coverage over incomplete
   reading — a requirement lost, with nothing saying so.

4. **Every block lands in exactly one chunk.** Coverage is counted in blocks, so
   a block in two chunks inflates it and a block in none is a silent hole. There
   is a test for both.

5. **The chunk ceiling is a refusal, not a truncation.** A project too large
   reports its unplaced blocks, which become `not_analysed` dispositions and
   block approval — rather than producing a confident baseline built from its
   first two hundred chunks.

### Reconciliation

Every chunk's candidates are combined before anything is written. Then:

- **Requirement keys are assigned globally**, in reading order, so REQ-001 is the
  first requirement in the first document.
- **Exact and near duplicates are computed deterministically**, by the
  application, keyed on normalised text. The model is asked separately about
  _restated_ duplicates — different words, same requirement — because that needs
  understanding and the other two do not.
- **Conflicts, ambiguity, gaps and terminology are asked once, over the whole
  set.** The evidence for these tasks is the requirements themselves, not the
  source pages, so the model compares statements rather than re-reading
  documents that would not fit.
- **Every block gets exactly one disposition**: covered, no-requirement (with a
  reason), duplicate-content, or not-analysed. The completeness is what makes
  coverage a real number rather than a ratio of things somebody remembered to
  count.

### Failure is partial and visible

A chunk that fails marks its blocks `not_analysed`. That lowers coverage, adds an
approval blocker and names the document. Failing the whole run would throw away
good work; carrying on quietly would produce a baseline with a hole in it that
nothing records.

## Consequences

**Good.** A requirement stated in one document and contradicted in another
surfaces as a conflict rather than whichever chunk ran last quietly winning —
which is the single most valuable thing this phase does, and it is only possible
because both survive to be compared.

**Cost.** The cross-chunk stage is six more inference calls on top of three per
chunk, and on CPU those are minutes. That is the price of the guarantee, and the
progress display says which stage is running rather than showing an unexplained
spinner.

**Block ids are scoped by source.** They are unique within a source and not
across a project: two pasted-text documents both start at `b0`. Keying anything
on the block alone collapses one document's data into the other's. This was a
real bug, caught by the integration suite, and both the reconciler and its tests
now key on `sourceId:blockId`.

**Deterministic duplicate detection is O(n²).** With the item ceiling at 2,000
that is four million comparisons of small token sets — under a second, and orders
of magnitude cheaper than one inference call. Anything cleverer would be a cache
to keep correct for no measurable gain.
