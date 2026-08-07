# ADR-0023: Two confidences, and only one of them governs

## Status

Accepted (Phase 4)

## Context

A requirement drafted by a model needs a number beside it saying how much to
trust it. There are two candidates, and they are not the same thing.

**The model's self-assessment.** Ask a language model how confident it is and it
will produce a number. That number is a token sequence, and its correlation with
correctness is weak, poorly calibrated, and worse on small models than on large
ones. It is also systematically optimistic about its own hallucinations — the
fixture in the integration suite has the model reporting 0.95 for a requirement
whose supporting quotation does not appear anywhere in the document it cites.

**Evidence.** Whether the requirement links to a real block, whether the quoted
excerpt is actually in that block, whether the citation locates a page or a row,
whether more than one document says it, whether a person has looked at it.

Merging them into one number produces a figure that means neither thing.
Discarding the model's leaves a field the model filled in and nobody can see.
Using the model's to gate approval lets the thing being assessed set its own
grade.

## Decision

**Store both, label both, and let only the evidence-derived one govern.**

### `MODEL_REPORTED_CONFIDENCE`

- Stored as the model gave it.
- Labelled **"AI self-assessment"** everywhere it appears, with the caveat
  ("not a probability; does not affect approval") rendered _next to the number_
  rather than in a footnote. A reader who sees 95% and not the warning has been
  misled, and putting the correction elsewhere does not undo that.
- Gates nothing. It appears in no calculation.

### `EVIDENCE_CONFIDENCE`

- Calculated by application code from stored facts, in
  `packages/contracts/src/analysis/evidence-confidence.ts`.
- **Deterministic.** The same evidence produces the same score, so a reviewer
  who returns tomorrow sees the number they saw today.
- **Explainable.** The score _is_ the sum of its listed contributions, each with
  a sentence a non-technical reviewer can read. There is no hidden term, and a
  test asserts the arithmetic.
- **Versioned.** `ruleVersion` travels with the score, so a value calculated
  under old rules can still be interpreted.
- **Governing.** It orders the review list (weakest first, because a reviewer's
  attention is the scarce resource), and an `unsupported` band blocks approval.

The signals are facts, not judgements: reference count, verified-quotation
count, located-reference count, distinct sources, whether every cited source was
reviewed, whether OCR was involved, whether extraction confidence was low,
whether a clarification supports it, whether a person accepted it — and, as
negatives, an unverified excerpt, an open conflict, open ambiguity, an
unreviewed source.

**The heaviest positive weight is a verified quotation**, because it is the one
signal a model cannot manufacture: the application checks the quoted words
against the stored block text itself.

Two facts short-circuit everything to `unsupported`, and both mean the same
thing — there is nothing to check this requirement against: no reference at all,
or a reference to a document this project does not have.

### Recalculation, not maintenance

Scores are recomputed from stored records whenever anything that feeds them
changes: a conflict resolved, a question answered, an item accepted. A score
computed once and left alone becomes a stale number presented as a current one,
and this one sits next to a button marked _Approve_.

## Consequences

**Good.** The number that gates approval cannot be influenced by the thing being
assessed. A reviewer can disagree with a specific listed reason rather than
distrusting an opaque figure. And the two-number display makes the gap visible:
seeing "AI self-assessment 95%" beside "Not evidenced" is a more useful piece of
information than either alone.

**Cost.** Recomputing every score on every change is more work than adjusting a
counter. It is a handful of milliseconds over an in-memory list, against the
alternative of a completeness figure that is one missed update away from being a
confident lie.

**The weights are a judgement.** They are not measured against a labelled
corpus, because no such corpus exists for this. They are set to a defensible
shape and are versioned so they can be changed without invalidating what came
before.
