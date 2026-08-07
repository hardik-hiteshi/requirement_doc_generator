# 27. A person's technology decision outranks the model's, structurally

Date: 2026-08-07

Status: Accepted

## Context

Phase 5 asks a language model which technologies a project should use. That is
useful — a reviewer with a half-decided stack gets a starting point with reasons
attached — and it is the single most dangerous thing this application does with
a model, for one reason: **the output looks exactly like a decision.**

A recommendation and a choice are both a technology name in a category. Once
stored, nothing in the shape of the data distinguishes "the model suggested
PostgreSQL" from "the client requires PostgreSQL". By the time it reaches an
estimate, a Statement of Work and a signature, the difference has been lost —
and the client is reading a document that attributes a decision to them that
they never made.

The specification is unambiguous about what must not happen: a user who selects
React, Laravel and MySQL gets React, Laravel and MySQL, whatever the model would
have preferred. The question is how to make that hold in code rather than in a
code review.

## Decision

**Authority is a value on every component, and it is checked at every write.**

```
LOCKED_USER_SELECTION            a decision, sealed
  > USER_APPROVED                a decision, reviewed
    > USER_SELECTED              a decision
      > AI_RECOMMENDATION        a suggestion
        > UNDEFINED              nothing yet
```

`canOverride(incoming, held)` is strictly greater-than, never
greater-or-equal. Two things follow from the strictness: a recommendation can
only ever occupy an empty slot, and re-running recommendation over an already
recommended stack is idempotent rather than a slow random walk through the
catalogue.

**Two guards, not one.** `categoriesToFill` removes every decided category
before the model is asked, so a recommendation to replace Next.js cannot exist.
`aiMayReplace` is then checked again at the moment of the write, because a
filter is a decision made a moment earlier against a list that could have
changed, and the write is where the damage would happen. The redundancy is the
point.

**The model has nowhere to express authority.** Its output schema carries a
category, a catalogue id, prose, and a self-assessment. No status field. No
authority field. No version. No risk level. A model cannot say a technology is
locked, cannot claim a version number it has no way to know, and cannot label
its own observation `BLOCKING` — the absences are load-bearing, and there are
tests asserting each one.

**Disagreement is loud, and it is not a substitution.** When the application
believes a user's choice is wrong it produces a compatibility finding: shown on
screen, blocking approval until acknowledged, carried into the estimate and into
the documents. The user reads it and keeps their choice. That is where user
authority and honest reporting meet, and acknowledging is how they coexist.

**Locking is a wall with one door.** `LOCKED` transitions only to
`USER_APPROVED`, and only through an explicit unlock that supersedes the
snapshot. No re-recommendation, no baseline change, no bulk operation reaches
through it.

## Consequences

The expected failure mode is conservative: a category left empty because the
filter excluded it, or a suggestion the model would have made that never got
asked for. A user notices an empty row and fills it. The alternative failure —
a technology silently replaced — is one they would not notice until delivery.

A model that genuinely knows better cannot act on it. It can say so, at length,
in the rationale and in `concerns`, and a person can agree. That asymmetry is
deliberate: the cost of the model being ignored is a slightly worse stack; the
cost of the model being obeyed is a proposal that misrepresents what the client
asked for.
