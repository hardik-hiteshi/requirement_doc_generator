# 37. The Statement of Work is contract-ready, and is not a contract

Date: 2026-08-11

Status: Accepted

## Context

A statement of work is the document that gets signed. Everything else in this
application feeds a decision; this one _is_ the commitment.

That changes what a mistake costs. An invented figure in Our Understanding is caught in
review. An invented clause in a statement of work is caught by a lawyer, months later,
during a dispute — and until then it is the agreement.

Language models are good at this document, which is exactly the problem. Asked for a
statement of work they produce something that reads complete: governing law,
limitation of liability, payment terms, a warranty, a termination clause, two backend
developers and a go-live date. Every one of those is an obligation nobody created, and
they are convincing enough that a reviewer skims past them because the document "looks
right".

There is a second exposure with no legal weight and real commercial weight. The
estimate behind this document was produced with AI assistance and the implementation
will be too. Whether to tell a client that is a decision with consequences, and it
belongs to the person sending the document — not to whichever adjective survived a
prompt.

## Decision

**Every material claim is a transcription.** Scope from the approved Feature Listing,
technology from the locked stack name for name, the timeline from the approved
schedule, assumptions from the approved Assumptions document, acceptance pointing at
the approved Acceptance Criteria. The composer copies; the validator proves it copied.

**Four sections are not model-writable at all.** `technology`, `timeline`,
`milestones` and `assumptions` quote approved artifacts, and asking a model to improve
one means letting it change a version number, a date or an assumption's status by
rewording. `MODEL_WRITABLE_SOW_SECTIONS` excludes them, and the prompt for the rest
forbids dates, durations, hours, technology names, staffing and legal terms — with the
schema carrying no field for any of them.

**Legal and commercial language is BLOCKING, not a warning.** Governing law,
jurisdiction, indemnity, warranty, liability limitation, payment terms, penalties,
IP transfer, SLA credits, termination, prices and rates. A warning would be
acknowledged and the document would ship.

**What is missing is named as missing.** `OUTSTANDING_COMMERCIAL_TERMS` is written into
the document as a list of what has _not_ been provided. A document that silently omits
commercial terms reads as complete; one that invents them is worse; saying "these have
not been agreed" is the only honest option and also the useful one, because it tells
the sender what they still have to add.

Those terms are named as categories — "Contractual and legal provisions" — rather than
as clause names. Writing "governing law, liability and warranty" to say they are absent
would put clause language into the document and trip the check above. Exempting the
section from its own check would leave a hole exactly where an invented clause would
hide.

**Nothing about how the work is built.** `INTERNAL_METHODOLOGY_PATTERNS` blocks
"AI-assisted development", "vibe coding", "prompt engineering", model names, "language
model", productivity multipliers and confidence figures. If disclosure is ever wanted
it is a deliberate feature, not a default.

**Responsibilities, never headcount.** `STAFFING_CLAIM_PATTERNS` blocks "two backend
developers", "a team of four", "will be assigned". "Backend engineering — API and
server-side business logic" claims nothing about who does it or how many of them there
are, and is what the client actually needs to know.

**The timeline says only what the schedule permits.** With no agreed start date the
document says "approximately N working weeks following the agreed project
commencement" and contains no calendar date; `inventedDates` blocks any that appear. A
fixed deadline is preserved exactly. An estimate accepted at high risk states the
approved timeline and the risk — substituting a safer date would be this application
making a commercial decision on somebody's behalf.

**Scope reconciles in both directions.** Scope in the document that is not in the
Feature Listing is work nobody estimated. Scope in the Feature Listing the document
omits is work the client has not been told they are buying, and it is the one that gets
missed. Both block.

## Consequences

The generated document is duller than a model would write, and shorter. It has no
flourish, no "cutting-edge", no closing paragraph about partnership. That is the
correct trade: the parts a generator is good at inventing are the parts that must not
be invented.

Reconciliation matches features by their _description_ rather than their id, because
the ids are ours and must never reach a client document — so the check works on the
words a client actually reads.

A project whose brief excludes something the estimate priced cannot approve its
statement of work until somebody resolves the disagreement. This looks like an
obstruction and is the feature: a commercial document that claimed both would be signed
by two parties who understood it differently.

The section a reviewer most often has to write themselves is the objective, because a
brief frequently states what to build without stating why. It is omitted with a reason
rather than filled in, since inventing a purpose for somebody's project is the same
error as inventing a clause, with better manners.
