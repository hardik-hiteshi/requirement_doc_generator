# 28. A reviewed catalogue, with commercial technologies in it

Date: 2026-08-07

Status: Accepted

## Context

Two questions had to be answered together, because the obvious answer to each
makes the other worse.

**Where do technology names come from?** Letting a small self-hosted model
free-associate produces confident nonsense: frameworks that do not exist,
licences it has misremembered, "the latest version" invented on the spot. All of
it lands in a document a client is asked to sign, asserted in the first person
by the agency writing it.

**Is a commercial technology allowed?** This application must run without paying
anyone — that constraint has held since Phase 1 and is not negotiable. The
projects it analyses are under no such constraint. A client who already runs on
AWS, takes payments through Stripe and authenticates with Auth0 has made those
decisions, and a tool that refused to name them would be useless to the person
writing their proposal.

The tempting answer to the first question — a catalogue — makes the second
harder, because a catalogue curated by an application with a no-paid-services
rule will quietly acquire that rule as an editorial policy.

## Decision

**A versioned catalogue, written by people.** `TECHNOLOGY_CATALOG` holds the
technologies a recommendation is allowed to name. The model returns an id; the
structured-output validator rejects anything not in the list; the run is
repaired or discarded. Every entry carries a `catalogVersion` and a
`lastReviewed` date, and a validation suite asserts that ids are unique, aliases
do not collide, every incompatibility points at something that exists, every
entry states a licence, and anything that costs money explains what committing
implies.

**The facts come from the catalogue, not the model.** Licence, cost posture and
self-hostability are copied from the reviewed entry at the moment of the
decision. The model contributes prose and a self-assessment, and never a
commercial fact — because a commercial fact is what a client makes a budgeting
decision on.

**Commercial entries are present on purpose.** AWS, Azure, GCP, Stripe, Auth0,
SQL Server, Oracle, Datadog and the rest are all in there. What the application
owes a reader is not omission but an honest label: `USAGE_BASED`, `COMMERCIAL`,
`MIXED`, plus a note about what committing means. The generator's own
no-paid-services rule governs the generator, not its clients.

**The constraint is read from the requirements, not assumed.** When the approved
baseline says everything must be self-hosted, choosing a hosted service is
`BLOCKING` and cites the requirement. When it says nothing, choosing AWS is
unremarkable. The same code produces both, from what the client actually wrote.

**No prices.** There is no maintained source for what AWS costs today, and a
number recalled by a language model inside a signed estimate is a liability.
`costPosture` says _how_ a technology charges — free when self-hosted,
usage-based, commercial licence — which is stable, checkable, and the thing that
actually changes a delivery plan.

**Almost no versions.** `recommendedVersion` exists and is nearly always absent.
A version is recorded only with a provenance — `REQUIRED_VERSION`,
`USER_SELECTED_VERSION`, `CATALOG_RECOMMENDED_VERSION` — and `UNSPECIFIED` is
both the default and the honest answer. The prompt says outright: do not state a
version, not "the latest", not a number.

**The user is not limited to it.** A technology the user types is authoritative
and needs no entry. It carries fewer known facts, and the screen says so —
_"this application holds no reviewed licence or cost information about it"_ —
rather than showing blanks that would read like facts. A typed name that matches
the catalogue resolves to it, so "postgres" inherits the reviewed facts instead
of becoming a custom entry with none.

## Consequences

The catalogue is a maintenance obligation. It goes stale, and `lastReviewed`
makes that visible rather than silent. It is broad rather than exhaustive by
design — covering what the supported project types need, with the mainstream
choice and the common alternatives in each — and the custom-technology path is
what makes an incomplete catalogue merely inconvenient rather than blocking.

A model that knows a technology the catalogue does not cannot recommend it. That
is the trade accepted here: a narrower set of suggestions, every one of which
carries facts a person checked.
