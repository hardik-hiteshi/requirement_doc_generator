# Effort estimation, capacity and timeline planning

How Phase 6 works. The product-facing description is in [estimation &
timeline](../product/estimation-and-timeline.md); the decisions are in
[ADR-0030](../adr/0030-effort-duration-capacity.md) and
[ADR-0031](../adr/0031-hybrid-estimation.md).

## The shape

```
approved baseline ─┐
locked stack ──────┼──▶ estimate lines ──▶ EFFORT (hours, per role, with a range)
requirements ──────┘          │                        │
                              │                        ▼
                              │            team + calendar ──▶ CAPACITY (hours available)
                              ▼                        │
                     dependency graph ─────────────────┼──▶ DURATION (working days)
                                                       │
                                                       ▼
                                                  FEASIBILITY ──▶ blockers ──▶ approve
```

Three quantities, three calculations. Nothing takes effort and returns a
duration — see ADR-0030 for why that division is the most common way a plan goes
wrong.

## What each piece owns

| Module                       | Owns                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `role.contract.ts`           | The 11 roles, and which a project has                          |
| `complexity.contract.ts`     | Complexity from drivers; uncertainty from unknowns             |
| `productivity-model.ts`      | Base hours, the AI-assistance table, the floor, overhead rules |
| `effort-range.ts`            | Optimistic/expected/conservative, and aggregation              |
| `calendar.contract.ts`       | Working days, holidays, and all date arithmetic                |
| `capacity.contract.ts`       | Hours available, utilisation, recommended staffing             |
| `dependency.contract.ts`     | The graph, its validation, and cycle detection                 |
| `scheduling.ts`              | The scheduler, the critical path and slack                     |
| `feasibility.ts`             | Whether it fits, and why not                                   |
| `estimate-blockers.ts`       | Why approval is refused                                        |
| `estimation-engine.ts` (API) | One requirement into one estimate line                         |

Everything except the engine is in `@wdrg/contracts` and is pure — which is why
the arithmetic is unit-tested without a database or a network.

## Effort

`estimateUnit` classifies the requirement, collects complexity drivers from its
own words and from the locked stack, and computes:

```
base(category) × complexityMultiplier × aiAssistanceFactor(category) × quantity
```

floored at `MINIMUM_FEATURE_HOURS`, then split across the roles the project has.

**The split never loses hours.** A share pointing at a role the project does not
have is first offered to a _substitute_ — mobile does the interface work when
there is no web frontend — and only redistributed if there is none. A project
with both a web frontend and a mobile framework splits the interface share
between them, because that work genuinely happens twice.

**Technology impact is traced.** Every driver names a `technologyId` from the
locked snapshot. Two native platforms cost more than one cross-platform
framework; on-premise hosting costs more than managed; a model whose outputs vary
costs more than a deterministic service. The estimator prices the stack and has
no path to changing it.

**Overhead is lines, not a percentage.** Nine activities from `OVERHEAD_RULES`,
proportional or fixed, each becoming a real estimate line with its own rationale.

## Capacity

`people × productiveHoursPerDay × availability × usableDays`, per role, where
`usableDays` accounts for a role that joins late.

`SUSTAINABLE_UTILISATION` is 0.85, not 1.0 — a role at exactly its theoretical
capacity has no slack for the things that always happen.

With no team supplied, `capacityUnknown` is true and `recommendStaffing` answers
the other question: what would this need? Fractional figures stay fractional and
carry a sentence explaining them in days a week.

## Duration

`buildSchedule` walks the graph in topological order (Kahn's, with a
deterministic tie-break) and places each task at the earliest day its
predecessors allow _and_ its role has a free slot. Slots per role come from the
team; a role with one person cannot run two of its tasks at once.

A backward pass computes the latest finish, and slack is the difference. The
**critical path is every zero-slack task** — derived from the arithmetic, never
declared by a model.

Everything is in **working-day offsets from day 1**, and a start date is applied
at the end. That is what makes recalculating dates a single operation that
touches nothing else, and what lets a project with no start date have a real
schedule rather than a degraded one.

## Feasibility

`assessFeasibility` compares the schedule's length and the capacity against the
timeline the user set. The checks are ordered so the two "we cannot say" answers
come first: `TIMELINE_UNMEASURABLE` (a deadline with no start date) and
`CAPACITY_UNKNOWN` (no team) — reporting `HIGH_RISK` when the real problem is a
missing input would be a claim the data does not support.

**Nothing in this file changes the timeline.** The gap is reported in hours or in
working days, the risks are listed, and the decision is the user's.

## The AI half

One task, `estimation.assess`, using Phase 4's provider layer unchanged — the
same endpoint guard, task runner, structured-output validation and model
profiles. No second inference system, and no scheduling library.

Its schema has nowhere to put hours, a role split, a technology, a dependency or
a date. It returns a task category, a complexity, the drivers, and the unknowns —
which `estimateUnit` then converts through exactly the same arithmetic the
deterministic path uses. There is no second code path.

Requirement ids are verified semantically. A failure records the run as failed
and changes nothing; the deterministic engine still produces a complete plan.

## Storage

Four collections. `estimate_snapshots` holds one version with its totals,
schedule and feasibility as they stood. `estimate_units` and
`estimate_dependencies` are per-row so editing one is a small write with its own
optimistic concurrency. `estimation_runs` holds sizes, timings and failures —
never the requirement text it read.

**Override authority is enforced at the storage layer.**
`deleteReplaceableUnits` filters `source: { $nin: ['USER_OVERRIDE'] }`, so a
re-estimation cannot remove a user's line however the service is refactored. The
same applies to `userDefined` dependencies.

## Reading is recomputing

`assemble` recomputes effort, capacity, the schedule, feasibility and the
blockers on every read, and stores them after every write. It reads the baseline
through `BaselineService` so Phase 4's lazy outdated check runs — the same fix
Phase 5 needed.

The web client mirrors this: `useEstimate` sets `staleTime: 0` and
`refetchOnMount: 'always'`. A cached "the deadline is achievable" after a
document changed is not slow, it is wrong.

## Working without a model

`POST /estimation/run` with `useAi: false` touches no provider. The deterministic
engine is not a fallback — it always runs, and the AI path only supplies inputs
to it. A deployment with `AI_PROVIDER=disabled` estimates, schedules, approves
and proceeds.
