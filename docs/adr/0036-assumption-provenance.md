# 36. An assumption needs somebody behind it

Date: 2026-08-11

Status: Accepted

## Context

The Assumptions document is where this application is most likely to do real damage,
and the mechanism is banal.

A requirement does not say which currency. A generator that fills gaps writes "we
assume payments are in GBP". The sentence lands in a document headed _Assumptions_,
which is approved along with everything else, and from that moment it reads as
something both sides accepted. Eighteen weeks later somebody discovers the client
always meant euros, and the conversation is about a document nobody remembers
agreeing to.

The gap was real information that needed asking about. Turning it into a sentence
made it look answered.

This is not a hypothetical failure mode of language models; it is what any
gap-filling generator does, and the more fluent it is the worse the outcome, because
a plausible assumption is one nobody queries.

There is a second, subtler version. A model reading a brief genuinely does notice what
a plan is resting on — that is useful, and refusing to use it would waste something
valuable. But a suggestion that arrives looking like a conclusion is the same failure
wearing better clothes.

## Decision

**Every assumption answers "why are we allowed to call this an assumption?"** That is
the `provenance` field, and the values that count are all a person: `CLIENT_STATED`,
`USER_STATED`, `CONFIRMED_CLARIFICATION`, `APPROVED_ESTIMATION_ASSUMPTION`,
`APPROVED_TECHNICAL_ASSUMPTION`.

**Deterministic composition produces only what somebody already stood behind.** There
is exactly one such source upstream: a clarification whose answer the user marked as
an assumption rather than a client fact. Phase 4 made them choose at the time, so the
mark is a recorded decision and copying it here adds nothing.

A project where nobody flagged anything therefore gets an **empty** Assumptions
document. That is the correct output, the screen says so in as many words, and
`mayBeEmpty` exists on the composer interface so the blocker calculation does not read
it as a failed generation.

**A model may suggest. Only a person may confirm.** Suggestions arrive as `DRAFT` with
provenance `MODEL_SUGGESTED`. `entersApprovedDocument` keeps every one of them out of
an approved document, and an undecided candidate blocks approval — not because
candidates are bad, but because leaving one unread is how a suggestion becomes a
commitment by default.

**The model cannot express an authoritative assumption.** `assumptionCandidateSchema`
has no field for `status`, `provenance`, `owner`, `confirmedBy` or `confirmedAt`. This
is deliberately a shape rather than an instruction: a rule the model is asked to follow
is a rule it can break, and a field that does not exist is not a field it can fill.
A response that tries is rejected before storage rather than filtered afterwards,
because filtering would make the attempt invisible.

**Confirming is an operation, not an edit.** `parseRowPayload` refuses a request that
tries to change `status`, `provenance` or `confirmedBy` by editing the row — refuses,
rather than silently ignoring, since silently ignoring would look like it worked. The
confirm endpoint asks what the assumption rests on and the application supplies
`status`, `confirmedBy` and `confirmedAt` itself.

**Open questions stay open.** `openQuestionsTreatedAsAssumptions` compares confirmed
assumptions against clarifications nobody has answered and blocks when an assumption
restates one. A blocking clarification stays a blocking clarification; nothing in this
document clears it.

## Consequences

The Assumptions document is often short, and sometimes empty. That is the intended
outcome and the interface presents it as an answer — "a complete answer, not a gap" —
rather than as an empty state inviting somebody to fill it.

Impact is qualitative: `LOW`, `MEDIUM`, `HIGH`, `BLOCKING`, plus a sentence and the
areas affected. No hours, no weeks, no percentages. A fabricated quantity in a risk
column is worse than an honest adjective, because it invites arithmetic.

The Statement of Work carries only assumptions this document confirmed, checked by
comparing its assumptions section against the approved list. A new assumption
discovered while writing the SOW routes back here rather than being written there,
which means the SOW can be blocked by an assumption nobody has decided about — the
correct outcome, and the reason it is worth the extra step.

The cost is friction: somebody has to type a sentence for every assumption. That
sentence is the entire value of the document.
