# 38. The Work Breakdown Structure projects the approved plan and never re-derives it

Date: 2026-08-11

Status: Accepted

## Context

By the time a work breakdown is generated, Phase 6 has already answered every
quantitative question about this project: hours per role for every unit of work, the
order those units run in, which working day each starts and finishes on, how much
slack each has, and which chain is critical. A person read all of that and approved it.

A work breakdown is the same information arranged so a delivery team can pick it up.
That leaves an obvious temptation: the composer has the estimate units, the calendar
and the dependency graph in front of it, so it could compute the schedule itself.

It must not, and the reason is not fastidiousness. Two planners produce two answers.
They diverge on rounding, on how parallelism is assumed, on whether review days are
counted — and then the estimate says nine weeks, the breakdown says ten, and nobody
reading them can tell which is the plan. The document that gets planned against is
whichever one somebody opened. A single plan that is slightly wrong is worth more than
two plans that disagree slightly.

There is a second pull in the same direction. A work breakdown is where somebody
naturally wants to adjust the schedule: move a task, shorten a duration, take something
off the critical path. Allowing that here would make this document a second place where
the plan is decided, with no approval attached to the change.

## Decision

**Every number is copied.** `effort` comes from the estimate unit; `relativeStartDay`,
`relativeFinishDay`, `workingDuration`, `slackDays` and `onCriticalPath` come from the
scheduled task Phase 6 produced; milestones come from the approved milestone list.
`UpstreamPlan` carries the full Phase 6 shape rather than a narrowed copy, precisely so
there is nowhere else a start day could be decided.

**The copy is proved, not trusted.** `reconcileWbsEffort` compares the breakdown's leaf
tasks against the approved estimate **per role** as well as in total, because two roles
can offset each other and leave a believable grand total — the most misleading result
available. A mismatch is a BLOCKING finding and a `wbs_not_reconciled` blocker: the
document stays readable and cannot be approved.

**Hours are compared at hundredths.** Phase 6 produces figures like 4.48 hours. A
whole-hour comparison would let half an hour per role pass unnoticed, and whole-hour
allocation would silently drop the fraction — so `allocateEffort` works in hundredths
of an hour and `roundHours` is applied to every sum. Float addition would otherwise put
`70.46000000000001` on screen and fail its own equality check.

**Decomposition preserves the total exactly.** A task may be split into several, and
`allocateEffort` divides the approved figure by largest remainder so the parts sum to
what was approved. Ten hours across three tasks become 3.34, 3.33 and 3.33.

**Schedule fields are refused on the write path.** Editing `relativeStartDay` or
`onCriticalPath` returns `SCHEDULE_NOT_EDITABLE_HERE`, whose message names the
estimation step and says why the change belongs there. Following the precedent set by
`EFFORT_NOT_EDITABLE_HERE`, it must not read as "you cannot change this".

**Hours are deliberately _not_ refused.** Splitting a task or moving work between roles
is a legitimate correction, and reconciliation is the check rather than a locked field:
the document simply cannot be approved until its parts add up again. Guarding the
schedule and not the hours is the distinction between a figure that is _derived_ from
an approved plan and one a reviewer may legitimately restructure.

**Dates appear only when the approved plan has them.** With no agreed start date the
breakdown publishes working days, because turning day 12 into a Tuesday would invent
the commencement the estimate deliberately left open — and a client reads a date as a
promise. A date on a relative-only plan is a BLOCKING `invented_date` finding.

**Traceability runs to all four authorities, and feature coverage is measured.** A work
package cites approved requirements, the Feature Listing rows it delivers, its Phase 6
estimate units, and locked technologies. The feature link is derived from the approved
chain — a listing row records the estimate units it was priced from — so nothing is
inferred, and a unit spanning several rows keeps all of them.

`workKind` separates feature work from delivery overhead. CI setup has hours and no
listing row, because a client never agreed to it as a feature: counting it as unmapped
would report a correct breakdown as incompletely traced, and counting it as mapped would
invent a feature it supports. Classified, it is excluded from feature coverage and still
fully present in the effort reconciliation. An approved feature with no work against it
is then a BLOCKING finding rather than a number nobody computed.

**A model contributes wording and grouping.** `wbsTaskDraftSchema` has no field for an
hours figure, a day, a date, a critical-path flag or a status, so a model that tries to
state one produces a parse failure rather than a plausible number that quietly
disagrees with the estimate. Where it proposes splitting work it gives relative
weights, and the application converts those into hours.

## Consequences

The breakdown cannot say anything about cost or timing that the approved estimate does
not. That is the point, and it has a real cost: somebody who spots a genuine
scheduling problem while reading the breakdown has to go back to estimation, change it
there, re-approve, and regenerate. Three steps instead of one.

That is the right trade. The alternative is a plan that changed without an approval
behind it, and an estimate that no longer describes the project it was approved for.

Feature coverage means this document can be blocked by a gap that is genuinely upstream's
to fix — an agreed feature the estimate never priced. That is the right place to find out,
and the finding names the feature rather than the symptom.

Re-estimating underneath an approved breakdown correctly makes the whole downstream
chain non-authoritative, so the engine reports `prerequisite_not_approved` before it
reports the arithmetic. That ordering is deliberate: everything below a withdrawn
approval is built on sand, and saying so first is more useful than a per-role hours
comparison against a plan nobody currently stands behind.
