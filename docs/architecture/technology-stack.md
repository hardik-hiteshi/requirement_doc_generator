# Technology-stack recommendation, review and locking

How Phase 5 works, and why it is shaped the way it is. The product-facing
description is in [technology stack](../product/technology-stack.md); the
decisions are in [ADR-0027](../adr/0027-technology-authority.md),
[ADR-0028](../adr/0028-technology-catalogue.md) and
[ADR-0029](../adr/0029-stack-locking-and-downstream-authority.md).

## The shape

```
approved baseline ──┐
project types ──────┼──▶ category plan ──▶ undecided categories ──▶ stack.recommend
requirements ───────┘         │                                          │
                              │                                    (catalogue ids)
user selections ──────────────┼──────────────────────────────────────────┤
                              ▼                                          ▼
                     compatibility rules ◀────── catalogue facts ──── components
                              │
                              ▼
                          blockers ──▶ approve ──▶ lock ──▶ DownstreamAuthority
```

Everything above the compatibility rules is _inputs_. Everything below is
computed by application code from stored data, and recomputed on every read —
which is why the screen can be trusted to say whether approval is currently
possible.

## What each piece owns

| Module                             | Owns                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `technology-category.contract.ts`  | The 32 categories, their cardinality, and which need justification |
| `project-type-categories.ts`       | Which categories a project type has, and at what strength          |
| `technology-catalog.data.ts`       | The reviewed technologies and their commercial facts               |
| `stack-authority.contract.ts`      | The precedence, the statuses, the transitions                      |
| `compatibility.contract.ts`        | Every deterministic finding, and the only path to `BLOCKING`       |
| `stack-evidence.ts`                | The application-computed evidence score                            |
| `stack-blockers.ts`                | Why approval is refused                                            |
| `downstream-authority.contract.ts` | What a locked stack promises Phase 6                               |

The API's `StackService` orchestrates; `RecommendationService` is the only thing
that touches a model. Neither computes a fact about a technology — those all
come from the catalogue.

## The category plan

Computed from the project types, then narrowed by the requirements.

`planCategories` merges the plans of every selected project type, with the
strongest applicability winning: a category any one type requires is required
overall. A category no type names is `not_applicable`, and is not shown, not
suggested and not counted as missing.

**Justification-required categories are conditional everywhere, and no project
type can promote them.** `cache`, `search`, `vector_storage`, `message_queue`,
`api_gateway`, `realtime`, `containerization` and `data_processing` become
`optional` only when `planFor` finds a keyword match in an approved requirement,
and the matching requirement ids are recorded on the entry. The keyword list is
deliberately narrow — it names the thing itself, or a phrase that unambiguously
implies it — because the failure it guards against is a stack acquiring a cache
because a requirement said "fast".

`OTHER` and an empty project-type selection require nothing at all.
`projectTypeIsActionable` is false for both, which produces a
`project_type_unconfirmed` blocker rather than a guess.

## Constraints, from the requirements

`deriveConstraints` reads four things out of approved, non-rejected requirement
text: a self-hosting requirement, a no-spend requirement, a data-residency
requirement, and technologies mandated by name.

Two properties matter more than the matching:

**Every constraint carries the requirement ids behind it.** A constraint with no
evidence cannot escalate anything — the compatibility rules check for the ids
before producing a `BLOCKING` finding. This is what stops somebody's preference
being presented to a client as their own requirement.

**A mandate needs both halves.** A phrase that means _this is required_ (`must
use`, `the client requires`, `standardised on`) _and_ a technology name matched
as a whole word. "We use PostgreSQL today" is context; "the system must use
PostgreSQL" is a constraint. Whole-word matching exists because `includes('go')`
finds the Go language inside "category" and "algorithm", and a false mandate is
the most damaging thing this file could produce.

## Recommendation

One AI task, `stack.recommend`, using Phase 4's provider layer unchanged — the
same endpoint guard, the same task runner, the same structured-output
validation, the same model profiles. **No second inference system**, because a
second one would mean a second set of endpoint protections to keep in step.

Four guards, in the order they act:

1. **The request is filtered before the model sees it.** `categoriesToFill`
   removes anything decided, locked, already holding a suggestion, not
   applicable, or conditional-and-unjustified.
2. **The catalogue is the vocabulary.** The prompt carries the applicable
   entries; the semantic validator rejects any id not among them, any category
   not requested, any requirement id not supplied, and any duplicate category.
3. **Authority is assigned here, not returned.** Everything written lands at
   `AI_RECOMMENDED`, and `aiMayReplace` is checked again at the write.
4. **A failure changes nothing.** The run is recorded as `failed` and the stack
   is exactly as it was.

The evidence and the application facts go in as separate messages. Requirement
text is _evidence_ — delimited, in a `user` message, under Phase 4's
instruction/evidence boundary. The catalogue and the decided technologies are
application facts and go in as prior results. Neither is interpolated into the
system instruction.

A recommendation with no requirement ids behind it is stored as
`ARCHITECTURAL_DERIVATION`, not `CLIENT_REQUIREMENT`. That distinction survives
into the documents, so a proposal never tells a client they required something
they did not.

## Compatibility

`evaluateCompatibility` is pure, total and order-stable: the same stack produces
the same findings in the same order, which is what lets a test assert them and a
reviewer trust that nothing shifted between two visits.

Thirteen rule kinds. `BLOCKING` is reachable only through five of them —
category mismatch, mutual incompatibility, duplicate responsibility, unsupported
project type, mandate contradiction, self-hosting violation — and each rests on
a catalogue fact or an evidenced constraint. Everything softer tops out at
`HIGH`, which the user can acknowledge and keep.

A model observation arrives through `concerns`, is stored with
`deterministic: false`, is capped below `BLOCKING`, and is displayed as the
model's opinion rather than as a checked fact.

**A custom technology produces no findings at all.** It carries no reviewed
facts, and inventing them would be the worst available failure: authoritative-
looking guesswork.

## Storage

Three collections, split the way Phase 4's are.

`stack_snapshots` holds one version of the stack: the plan, the findings, the
blockers, the decisions, and the baseline version and project types _as they
stood_ — stored rather than read live, because a live read would silently agree
with itself and no change would ever be detectable.

`stack_components` holds one technology each, so accepting a suggestion is a
small write and optimistic concurrency is per-component.

`stack_recommendation_runs` holds sizes, timings and failures. **Never the
requirements it read** — a run record is what an operator looks at while
debugging a deployment, and the requirements are the client's confidential
material.

Two Mongoose traps were hit and are worth knowing: a `model` property shadows
`Document.model()` (the field is `modelName`), and an empty string counts as
absent for a `required` String — so a field that legitimately defaults to `''`
must not be required, or every custom technology is rejected.

## Reading is recomputing

`assemble` recomputes the plan, the constraints, the findings and the blockers
on every read, and `recalculate` stores them after every write. The stored copy
is a cache the approval endpoint reads; the recomputation is what makes the
screen honest.

It reads the baseline through `BaselineService`, not the repository, so Phase
4's lazy outdated check runs. Reading the collection directly — which the first
implementation did — meant the stack went on believing its requirements were
current long after a document changed.

The web client mirrors this: `useStack` sets `staleTime: 0` and
`refetchOnMount: 'always'`, overriding the application's 30-second default. A
screen whose job is to say whether the stack is still valid must not serve a
cached "everything is fine".

## Working without a model

`USER_SELECTS_ALL` touches no provider. Nothing in `StackService.select`,
`approve`, `lock` or `authority` reaches for one, and `RecommendationService`
takes the provider `@Optional()`, so a deployment with `AI_PROVIDER=disabled`
starts normally and the whole step works end to end. The screen says so rather
than looking broken.

This is not a convenience. If choosing a stack required a model, the entire
workflow would inherit a dependency on one.
