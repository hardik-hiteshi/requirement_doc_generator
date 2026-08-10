# 31. The model assesses; the application does the arithmetic

Date: 2026-08-07

Status: Accepted

## Context

Estimating a hundred requirements is exactly the kind of work a language model
is good at: it reads them all, it notices the multi-step approval and the
undocumented integration, and it does not get bored on the eightieth. A person
doing the same job skims by the fortieth.

It is also exactly the kind of work a language model is dangerous at. Asked "how
many hours?", it produces a number. The number is confident, plausible, and
arrived at by no process anybody can inspect — and it ends up in a fixed-price
proposal.

The two facts are not in tension if the model is asked the right question.

## Decision

**The model returns judgement about the requirement. The application converts
judgement into hours.**

`estimation.assess` returns, per requirement: a task category, a complexity, the
drivers behind that complexity, and the things nobody knows yet. Its schema —
`estimation-schema.ts` — has nowhere to put:

- **hours**, of any kind, per role or total or as a range;
- **a role split**, which follows from the task category and the project's
  applicable roles;
- **a technology**, because the stack is locked and a model that could name one
  could substitute one;
- **a dependency or a date**, because sequencing and scheduling are arithmetic
  and a model's date lands in a contract.

Every absence has a test asserting the schema rejects the field.

**Both halves run through one function.** `estimateUnit` takes the requirement,
the locked stack, and — optionally — the model's proposals. Called with no
proposals it is the pure deterministic path. Called with them it uses them as
_inputs_ to the same arithmetic. There is no second code path where a model's
number reaches the plan unexamined, and the deterministic engine is not a
fallback: it always runs.

**Complexity is derived from drivers, not asserted.** A model may propose a
level, and it is honoured — but the explanation shown on screen is regenerated
from the drivers, so a level with nothing behind it is visibly unexplained rather
than quietly authoritative. Nothing anywhere consults the requirement's _length_.

**The productivity model is written down and versioned.** `AI_ASSISTANCE_FACTORS`
is a table per task category, and its shape is the argument: scaffolding
compresses to 0.45 because it is pattern-following; integration barely moves at
0.9 because the difficulty is in the other system's behaviour; analysis and
coordination are 1.0 because they are conversations with people. Every estimate
records which methodology version produced it.

**A near-zero estimate is a defect.** `MINIMUM_FEATURE_HOURS` floors every line
at two hours, because a feature that reaches a proposal costing less has not been
thought about: it still needs specifying, reviewing, testing and deploying.

**Overhead is named, not padded.** Nine activities, each either proportional to
implementation or fixed — and fixed ones stay fixed, which is why a small project
carries proportionally more of them. "We added 30%" is not something a client can
evaluate or a delivery team can plan against.

**Nothing tells the client how the code was written.** `mentionAiAssistance`
defaults to false. A proposal that volunteers "we used AI to go faster" starts a
conversation about price that is the user's to start, not this application's.

## Consequences

The model's contribution is smaller than it could be, and the estimate is worse
for it in the cases where the model would have been right. That is the trade: a
figure whose derivation a delivery lead can walk through and disagree with, in
exchange for one that might have been closer.

The base-hours table is a maintenance obligation and will be wrong for some
teams. It is in one file, argued for in comments, and covered by tests that pin
its shape rather than its exact values — so disagreeing with it is a small,
visible change rather than an archaeology exercise.
