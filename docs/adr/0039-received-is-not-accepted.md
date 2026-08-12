# 39. On the dependency sheet, received is not accepted — and credentials are never stored

Date: 2026-08-11

Status: Accepted

## Context

The Client Dependency Sheet is the only document in this application whose primary
audience has to _act_. Everything before it describes what will be built. This one says
what the project cannot proceed without, who owns each item, and what happens if it is
late.

Two failure modes make sheets like this useless in practice, and both are about honesty
rather than features.

**The first is the single-status field.** A sheet with one column for "status" and a
tick in it collapses three different events into one: we asked, it turned up, and we
checked that it works. They are not the same. Sandbox credentials arrive that were
issued for the wrong environment. A product catalogue arrives in an encoding the
importer cannot read. An approval arrives from somebody without the authority to give
it. A project that treats arrival as resolution believes it is unblocked for a
fortnight, and finds out when the work starts.

**The second is vagueness.** "Client to provide all required information" appears on
almost every real dependency sheet. Nobody can action it and nobody can ever mark it
done, and three of those at the top of a sheet teach the reader that the whole document
is a formality.

There is also a security exposure specific to this document. Many rows are about
credentials — an API key for a payment provider, database access for a migration, an
account for an SMS gateway. A sheet is exported, emailed, and pasted into chat, and once
a value is in a document version it is in the immutable history for good. The
conversational pull towards "just record the key here so we have it" is strong, and it
is exactly wrong.

## Decision

**The lifecycle has nine states and `RECEIVED` is not one of the satisfying ones.**
`isDependencySatisfied` returns true for `ACCEPTED` and `WAIVED` only.
`DEPENDENCY_TRANSITIONS` makes `ACCEPTED` reachable solely from `RECEIVED` or
`VALIDATING`, so nothing goes from requested to accepted without passing through
arrival and a check.

**The three events are three API calls and three buttons.** `request`, `receive` and
`validate` each stamp their own timestamp, because a sheet whose job is recording what
arrived and when needs the time captured by the act rather than typed in afterwards.
The interface offers _Check it_ on a received item — never a tick — and `validate`
requires a note in both directions. "Accepted" with nothing behind it is
indistinguishable from "it arrived and nobody looked", which is the failure this whole
document is arranged to prevent.

**Status is refused on the ordinary edit path.** Setting `status: ACCEPTED` through a
row edit returns `DEPENDENCY_STATUS_NOT_EDITABLE_HERE`, so the project's "we are
unblocked" signal cannot be written into a text field with no timestamp behind it.

**A credential value is refused at every boundary.** `looksLikeSecret` is shape-based
and deliberately errs towards refusal: a false positive costs somebody a rewording, a
false negative writes a live credential into an immutable record. It is enforced in
`parseRowPayload` — before storage, not merely at approval — because validation is
advisory until somebody approves, and this must never be stored at all. The generation
schema has no field for a value either, and the model's semantic validator rejects
secret-shaped output as `disallowed_content`. A row records that credentials are
required, requested, received and validated; the value goes through the client's own
secret manager.

**Audit metadata carries the key and the states, never the row.** A dependency's text
can name a system, an environment or a person, and audit events are read by people who
were not cleared for the document. `CLIENT_DEPENDENCY_STATUS_CHANGED` records
`dependencyKey`, `from`, `to` and `credentialsRequired`.

**Every row is grounded, and vagueness is refused.** `sourceKinds` has no value meaning
"general": a row traces to an integration in the approved baseline, a third-party
technology in the locked stack, a task in the work breakdown, a confirmed assumption, an
unanswered clarification, or a person who stated it and said why. `isTooVague` refuses
the wording nobody can close, both from the composer and from a model.

**Unanswered clarifications become rows.** An open question _is_ a dependency on the
client, and a project that leaves it off this sheet waits quietly for an answer nobody
knows is outstanding. This is the only document for which unsettled clarifications are
evidence rather than something to be kept out.

**Owners are left blank and dates come from the plan.** Naming the wrong person in a
client-facing sheet is worse than naming nobody, and a person filling it in is one
click. Timing is relative to commencement unless the approved schedule carries real
dates.

**Outstanding items are not a blocker.** A blocker prevents approval, and a sheet that
could not be issued until the client had sent everything would be useless — sending it
is how you ask for the things on it. What is outstanding, and what of it is holding work
up, is reported through `dependencySummary` and as a validation finding, where a reader
sees it without being stopped by it.

**The sheet owns the link to the breakdown, and the reverse view is derived.** A
dependency row names the work packages waiting on it in `wbsIds`; the breakdown's own view
of that relationship is computed on read by `reverseDependencyIndex`, never stored.

The alternative — a `clientDependencyIds` field on each work package — would mean
generating document 7 had to write into document 6. Document 6 may already be issued, and
an issued document is history. A stored copy could also drift out of step with the sheet,
which is the failure that matters: a task claiming to wait on a dependency the sheet no
longer contains. Derived, there is nothing to drift.

Every derived entry carries the sheet's `status` and `currentness`. A reverse link out of
a stale sheet is still worth showing — the dependency probably still exists — but it has
to be labelled, or the breakdown appears to make a current claim it cannot support.

`wbsIds` is validated on the write path against this project's breakdown, so a dangling
reference cannot be stored and an id belonging only to another project cannot resolve.

## Consequences

Closing an item takes three deliberate actions and a note, where one tick would do. On
a forty-row sheet that is real friction, and it is the friction that makes the record
worth anything three months later when somebody asks when the project was unblocked and
on whose word.

Reading the breakdown costs one extra query for the sheet's rows. That is the price of
having one authority for the relationship instead of two copies that can disagree.

Refusing secret-shaped text will occasionally reject a legitimate description — a row
about a token whose example format happens to match a pattern. The message says what it
looked like and asks for a rewording, and that cost is not comparable to a live
credential in an issued document version.
