# 41. Traceability is derived from recorded links, never inferred from prose

Date: 2026-08-12

Status: Accepted

## Context

By the end of Phase 9 an approved requirement can appear in seven documents, and it is
cited differently in each: by key in a section's references, by feature id in the listing,
by estimate unit in the work breakdown. "We agreed to this — where is it?" is therefore
not a question anybody can answer by reading the documents, and the interesting answer is
the one where the chain _breaks_. A requirement that is agreed, priced and nowhere in the
plan is expensive, and it is invisible from inside any single document.

There are two temptations. The first is to store a traceability table and keep it updated.
The second is to infer links by looking for a requirement's words in a document's prose.

## Decision

**Derived on request, from the links the documents already record.** A section keeps its
`references`; a feature row, criterion, work package and dependency each keep
`requirementIds`. The view walks those. A stored table would be a second copy that can
disagree with the documents, and the disagreement would be invisible until somebody
trusted it.

**Nothing is inferred.** If Our Understanding does not cite `REQ-004`, the view reports
that `REQ-004` does not appear in Our Understanding. It does not search the prose and
guess. A traceability view exists to show gaps, and a guessed edge hides one — which makes
inference not merely imprecise here but self-defeating.

**Two documents are conditional.** Assumptions records what somebody stood behind; the
Client Dependency Sheet records what the client owes. A requirement with no assumption and
no client dependency is the ordinary case. `isConditionalDocument` marks them, and they are
reported without penalty — counting them would make coverage a figure nobody could ever
reach, which is the same as having no figure.

**A work package classified as delivery overhead is not an unsupported row.** CI setup
citing no requirement is correct, and flagging it would penalise the right answer.

**Gaps carry proportionate severity.** A dangling citation is a document claiming support
it does not have, and blocks. A work package with no requirement may be legitimate
overhead, and warns. Making every optional relationship blocking would teach people to
acknowledge findings without reading them, which costs more than the findings are worth.

**Audit records counts, never requirement text.** A requirement title is
client-confidential and an audit trail is read by people who were not cleared for the
document.

## Consequences

The view costs seven document reads, their rows and their sections. It is paid on a screen
somebody opens deliberately rather than on every document read, and the alternative is a
cache that lies.

Coverage will rarely read 100%, because a requirement can be legitimately excluded from a
document with a recorded reason and that is reported separately from being missing. A
figure that is usually short of complete, with the shortfall explained, is more useful than
one engineered to look finished.
