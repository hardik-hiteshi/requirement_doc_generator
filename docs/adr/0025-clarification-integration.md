# ADR-0025: A confirmed clarification is evidence, not an assumption

## Status

Accepted (Phase 4)

## Context

Phase 4 shipped clarification questions and a way to answer them. What it did
with the answer was wrong.

An answer was recorded, and if the person marked it as one, an assumption item
appeared in the baseline. The requirements the question was about were left
saying exactly what they had said before. So this:

> **REQ-001** — Users can approve requests.
> **Q-001** — Which users can approve?
> **Answer** — Only Project Managers.

produced a baseline still containing _"Users can approve requests"_, with the
useful part of the exchange sitting in a separate list. And in the assumption
path it produced _"Assumption: Project Managers can approve requests"_ — which
understates what is known. Nobody assumed it. The client said it.

Two things were missing. A confirmed answer is **evidence**, at least as good as
a line in a document, and the requirements it touches should say what it says
and cite it. And an assumption is a specific, narrower thing: something taken as
true that nobody confirmed.

## Decision

### Answering and confirming are separate acts

An answer typed after a meeting and an answer the client has agreed to are
different things. Answering stores text; **confirming** is what makes it
evidence, and it is what triggers integration. Until then the question still
blocks approval, because the baseline does not yet reflect anything.

The lifecycle is `UNANSWERED → ANSWERED → CONFIRMED → INTEGRATING →
INTEGRATED | NEEDS_REVIEW | FAILED`, with `SUPERSEDED` for a replaced answer
version and `DISMISSED` for a question a reviewer judged not worth asking. Only
`INTEGRATED` and `DISMISSED` stop it blocking approval.

### Integration is targeted

Only the requirements the answer touches go to the model — those the question
was filed against, plus those sharing a finding with it. Re-running the whole
project would take minutes on local hardware, would re-derive hundreds of
requirements nobody asked about, and would risk changing wording unrelated to
the answer.

The prompt is the question, the answer, and those requirements. Nothing else.

### Four preservation rules

| The requirement is…           | What happens                                    |
| ----------------------------- | ----------------------------------------------- |
| AI-generated, never touched   | Updated, with the previous version kept         |
| AI-generated, manually edited | **Proposed**, never applied                     |
| Written by a person           | **Proposed**, never applied                     |
| In an approved baseline       | **Proposed**, and the baseline goes out of date |

The three proposal cases exist because a person made a decision, and a model
does not undo one. What it may do is say "given this answer, I would put it like
this" and wait. A proposal carries the current wording, the proposed wording, the
reason, and which clarification it came from — and offers accept, keep, or edit.

Accepting sets `editedByUser`, so the next integration proposes to that item too.

### The clarification becomes a citable source

A requirement updated by integration gains a `TraceabilityLink` of
`kind: 'clarification'`, carrying the answer text, the answer version and the
question's key. That link is `verified: true` — not as a shortcut. A document
excerpt is verified by comparing it against stored block text, because the model
claimed it; this text is the answer _this application_ recorded, so there is no
third party's claim to check.

Evidence-derived confidence gains a `confirmed_clarification` signal weighted
like a corroborating source, and the explanation names it: _"Confirmed
clarification Q-004."_ A reviewer can go and read the answer it refers to.

The score remains entirely application-computed. The model still does not get a
vote.

### Answers are versioned

Changing a confirmed answer creates a new version, supersedes the old one,
marks the requirements the old version touched for revalidation, and takes an
approved baseline out of date. The previous answer stays readable, because a
requirement written against it has to remain checkable.

Requirements are versioned too, in their own collection, written before every
change by everything that changes one. "The AI rewrote my requirement" has to be
answerable with the previous wording in hand.

### Failure changes nothing

Nothing is written until the model's output validates. A failed integration
leaves the answer confirmed, every requirement as it was, and the clarification
in `FAILED` with a message saying so. An integration that half-succeeded would
be worse than one that did not run.

### What integration will not do

- **Create requirements.** The task's schema allows it and a larger model will
  propose them, but a requirement invented during integration has no source in
  any document and no reviewer looking for it, and it would arrive in a baseline
  as though the client had asked for it. If an answer implies a new requirement,
  a person adds it — marked as theirs.
- **Close a conflict.** Deciding that two statements no longer contradict each
  other is a decision, and integration does not make decisions. It may close a
  gap or an ambiguity, and only one it was given the requirements for.
- **Invent an answer, or choose between two.** An unanswered question stays
  unanswered and stays blocking.

## Consequences

**Good.** The exchange that produces the most valuable information in a
requirements process — asking a client a direct question and getting a direct
answer — now lands where it belongs: in the requirement, cited, at full evidence
weight. And an assumption means what it says again.

**Cost.** Confirming is an extra click. It is the click that separates "somebody
typed this" from "the client said this", and the whole design depends on the
distinction.

**Proposals accumulate.** A project where every requirement has been reviewed
will get a proposal for every affected requirement rather than an update. That
is the intended cost of never overwriting a decision, and the proposals panel
exists to make working through them quick.

**Deterministic re-checking is limited.** After integration, duplicate groups
whose members have moved apart are closed, ambiguity findings whose phrase has
gone are closed, and findings about rejected requirements are closed — all
without asking the model. Conflicts are never closed this way. Re-detecting
conflicts across a changed project is a full re-analysis, which is exactly what
targeted integration exists to avoid; the reviewer runs one when they want one.
