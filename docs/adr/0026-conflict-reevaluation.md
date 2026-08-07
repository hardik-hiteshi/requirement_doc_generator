# 26. A confirmed clarification re-opens the conflicts it touched

Date: 2026-08-07

Status: Accepted

Supersedes nothing. Extends [ADR-0025](0025-clarification-integration.md).

## Context

ADR-0025 made a confirmed clarification authoritative evidence: it revises the
requirements it answers rather than being filed away as an assumption. But it
stopped at the requirement. Conflicts — two client statements that cannot both
be true — were left exactly as the analysis found them.

That produced a workflow that reads as broken. A client is asked "who can
approve, users or managers?", answers "only managers", watches the requirement
change in front of them, and then finds the baseline still refusing approval
because a conflict about that very sentence is still open. The application
asked a question, got the answer, and did nothing with it.

The opposite failure is worse. If a confirmed answer cleared every conflict it
touched, an answer that changed the wording of one side without settling the
disagreement would silently close a contradiction that is still there — inside
a document a client signs.

Re-running the whole analysis after every clarification would find the truth,
and is not an option: it costs a full pass over every source, discards the
reconciliation and the human decisions layered on top of it, and takes minutes
on a project of any size.

## Decision

**Re-evaluate the conflicts a clarification could have reached, and no others.**

Scope is three ways in, computed from stored records:

- conflicts holding a requirement the integration applied or proposed;
- conflicts sharing a requirement with one of those — a conflict is between two
  requirements, and changing either changes the conflict, even when the
  question was filed against one side only;
- conflicts the clarification is linked to directly.

A project with three hundred conflicts and one clarification re-checks the two
it touched. Everything else is not looked at, and is not recorded as having
been looked at, because it was not.

**Six conditions decide, and the model may only withhold one.**

`evaluateConflictAgainstClarification` in `@wdrg/contracts` is a pure function
over facts, with no access to a provider. Five conditions are facts about
stored data:

| Condition                      | What it checks                                             |
| ------------------------------ | ---------------------------------------------------------- |
| `confirmed_answer`             | The answer was confirmed as the client's, not merely typed |
| `authoritative_not_assumption` | It is a client fact; an assumption settles nothing         |
| `linked_to_conflict`           | The question reaches a requirement in this conflict        |
| `all_positions_addressed`      | Every contradicting requirement was changed by it          |
| `updates_applied`              | Those changes are applied, not waiting for a person        |

The sixth, `semantic_agreement`, asks the model whether the answer addresses
what the two statements actually disagreed about. That is a question about
meaning and nothing else in the system can answer it. It is a **veto, not a
vote**: a `false` stops a resolution the other five would have allowed, and a
`true` can never supply a missing condition. The model's confidence is not
consulted — the task schema has no field to put it in
(`conflictReevaluationOutputSchema` is `{conflictId, settled, reason}`), and a
provider that fails, times out or is absent returns an empty map, which reads
as "did not agree".

All six hold → `resolved_by_clarification`. Not linked and nothing applied →
`open`, unchanged and honestly labelled. Reached but unsettled →
`needs_review` when every side was addressed, `still_conflicting` when one side
was left untouched. Both block approval, because an unsettled contradiction is
unsettled however it got that way.

**A person's decision is never revisited; a machine's always is.**

`resolved`, `dismissed`, `accepted_risk` and `superseded` are states a reviewer
put there, and a later clarification does not undo them.
`resolved_by_clarification` is deliberately not on that list: it was reached
automatically on the strength of an answer, so when the answer changes it is
evaluated again and can reopen. Protecting it alongside human decisions was a
real bug, caught by a test that changed a confirmed answer and watched a
resolved conflict stay resolved on evidence that no longer said so.

**Nothing is overwritten.**

Every re-evaluation writes an immutable snapshot of the conflict _before_ the
change into `conflict_versions` — original positions, source references, prior
status, who changed it and under which clarification key — then appends a
`ConflictReevaluation` record to the finding: previous and resulting status,
previous and resulting version, which conditions were met and which failed, a
plain-language rationale and a timestamp. "We looked at this again after Q-004
and it is still a contradiction" is as much an audit fact as a resolution, and
is stored when the clarification reached the conflict even if nothing changed.
The screen renders that history behind "What was conflicting before?".

**Dismissal is a closed list with a checked reference.**

A generic dismissal that clears a blocker on assertion is not offered. Four
dispositions — `ANSWERED_ELSEWHERE`, `DUPLICATE_QUESTION`, `NOT_APPLICABLE`,
`REQUIREMENT_REMOVED` — and the first and last are refused without a reference
that resolves: a source in this project, another question with a _confirmed_
answer, or a requirement that is actually rejected or superseded. The audit
event records the disposition, the reference and the actor, and never the
answer text or the question, which are the client's confidential material.

## Consequences

A client who answers a question sees the conflict it settled close, and sees
the conflicts it did not settle stay open with a reason. Both are the point.

Resolution is conservative by construction: five independent facts and a model
that can only object. The expected failure mode is a conflict that a reader
would call settled being left at `needs_review` for a person to close — a
minute of work, against a contradiction shipped in a signed document.

The deterministic provider used in CI withholds agreement for
`conflict.reevaluate`, so the automatic-resolution path is exercised by the
in-process integration suite with a scripted verdict rather than in the browser.
The browser suite covers what a reviewer sees: status, history, and a dismissal
that is refused when its reference does not check out.
