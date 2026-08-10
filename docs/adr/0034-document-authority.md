# 34. A document quotes its inputs; it never decides them

Date: 2026-08-10

Status: Accepted

## Context

A document is the last thing in the chain and the first thing a client reads. It
is also the easiest place in the application to introduce a lie, because prose
hides arithmetic. Three specific failures are available:

**A number that disagrees with the estimate.** A Feature Listing showing 640 hours
against an approved estimate of 720 is a commercial document that contradicts the
plan it was built from. Nobody notices until delivery.

**A commitment nobody agreed to.** Asked to write a section on non-functional
requirements when the baseline has none, a language model will produce "99.9%
uptime, GDPR compliant, sub-second response times". Every one of those is a
contractual obligation created by a text generator.

**Coverage that reads as complete when it is not.** A listing missing four
requirements, with no indication that anything is missing, is scope the client did
not buy and the team will discover in month three.

## Decision

**Hours come from the approved estimate, and only from there.**

`document.features` — the task that groups requirements into rows — has no effort
field of any kind in its schema. Not per role, not total, not as a range, not in
the description. A model cannot supply a number because there is nowhere to put
one.

Rows are built from estimate units, their hours copied and aggregated additively.
`reconcileFeatureEffort` then compares the document's total against the estimate's
over _distinct_ unit ids, and a mismatch is a BLOCKING validation finding.

Only an **approved** estimate is authority. A draft estimate's hours are still
being argued about, and quoting them to a client would put unsigned figures in
front of them.

A user who wants different hours is sent to the estimation step. The refusal says
where and why:

> Hours come from the estimate you approved, so they are changed there rather than
> here. Open the estimation step, override the figure, and re-approve — that way
> the change is on the record and every document agrees.

The UI does not render hours as inputs at all. A number in a text box invites an
edit the API refuses; the honest design is not to offer it.

**Invented commitments are checked for, not merely discouraged.**

`FORBIDDEN_UNDERSTANDING_PATTERNS` matches the phrases a model reaches for when a
section looks thin: availability percentages, concurrent-user figures, response
times, named compliance regimes, accessibility standards, marketing language, and
any mention of AI-assisted development. Each match is a BLOCKING finding naming
the phrase and why it cannot stand.

They are reported rather than stripped. Deleting the sentence would hide that the
model tried to invent a commitment, and a reviewer who cannot see the attempt
cannot judge the rest of the section.

A section with no supporting requirement is kept **empty with a reason** rather
than filled. "The approved requirements say nothing about this" is honest and
visibly different from a heading somebody forgot.

**Coverage is computed from disposition, never asserted.**

`applicable`, `represented`, `excluded`, `unresolved` — and `percentage` derived
from them. A requirement in no feature and not explicitly excluded is
`unresolved`, and any unresolved requirement is a BLOCKING finding. Reaching 100%
requires a decision per requirement, and a deliberate exclusion carries the reason
with it.

**Deterministic checks are authoritative; a model can only add.**

`MODEL_RAISABLE_KINDS` limits model findings to four judgement kinds —
unsupported statement, terminology inconsistency, scope contradiction, duplicate
content — and every one is folded in as a WARNING. A model cannot create a
blocking finding, cannot clear one, and cannot downgrade one. A model that could
turn BLOCKING into WARNING would be a model that can approve a document.

Every finding records `detectedBy`, so a reader can tell a fact from a judgement.

## Consequences

A Feature Listing cannot be approved while its hours disagree with the estimate,
which means regenerating after an estimate change is mandatory rather than
optional. That is the intended friction: the alternative is two documents with
different numbers.

The deterministic composer's module names and descriptions are plainer than a
model's. It says so in its own comments. What matters is that the plain version is
_derived from the requirement_ rather than invented, and that a model improving the
prose cannot change what the document commits to.

The forbidden-pattern list is a denylist, and a denylist is never complete. It
catches the specific phrases this failure mode actually produces; the general
defence is that a section may only cite requirements it was given, and that a
reviewer sees every citation.
