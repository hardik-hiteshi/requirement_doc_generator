# Documents

Phase 7. One engine, a composer per document, and six collections.

## The shape

```
DocumentsController ── one set of routes, document type in the path
        │
DocumentsAiService ─── the model's half; falls back to the engine on any failure
        │
DocumentsService ───── the engine: status, versions, edit protection,
        │               dependency graph, validation, approval, audit
        ├── UpstreamReader ─── the approved baseline, locked stack, approved estimate
        ├── UnderstandingComposer ─── sections, and what makes them valid
        ├── FeatureListingComposer ── rows, coverage, reconciliation
        └── DocumentsRepository ───── five collections
```

Adding a document is a composer and a row in `DOCUMENT_DEPENDENCIES` — ADR-0033.

## What each piece owns

**`@wdrg/contracts/documents`** holds everything that is arithmetic or vocabulary:
the status table, the dependency graph, outdated propagation, coverage,
reconciliation, duplicate and hierarchy detection, the forbidden-content patterns,
the strict CSV serialiser and its validator. All of it is pure and unit-tested
without a database — 98 tests.

**`DocumentComposer`** knows one document: which sections exist, which requirements
belong where, what makes it valid, which requirements it is answerable for. It
takes no provider and cannot make a network call.

**`DocumentsService`** knows nothing about any particular document and owns
everything else. It is the largest file in the phase, deliberately: "how does
approval work" is one method rather than a comparison across five services.

**`DocumentsAiService`** wraps the engine. It runs four versioned tasks and folds
the result into the deterministic composition. Every failure path falls back.

## The dependency graph

```
approved requirement baseline
           ↓
   Our Understanding
           ↓
    Feature Listing  ←  locked technology stack
                     ←  approved estimation snapshot
```

`DOCUMENT_DEPENDENCIES` records upstream artifacts and prerequisite documents per
type, for all seven. `lockFor` turns that into a lock with a reason — unimplemented
first, then a missing upstream artifact, then an unapproved prerequisite, in that
order because a missing baseline is the more fundamental problem.

`documentOutdatedReasons` compares the versions a document was written against with
the versions that are current. Three cases:

- **a version changed** — reported with both numbers;
- **an input disappeared** (a stack unlocked, an estimate reopened) — reported as
  no longer approved, which a version comparison cannot see;
- **a baseline went stale without changing version** — Phase 4 keeps an
  approved-then-outdated baseline at the same version, so the engine checks
  `baselineCurrent` separately.

A prerequisite document changing is recorded on **every** document downstream of it
when it happens, by `markDependentsOutdated` over `downstreamDocuments` — the
transitive closure, not just the next document along. In a chain of seven, a
baseline change under Our Understanding reaches the Client Dependency Sheet through
five intermediaries, and telling only the next one would be the smallest true thing
rather than the useful one.

Nothing is regenerated and no status is written: a document that goes out of date
keeps its content, keeps its status, and gains a reason. Regenerating is what
clears the reasons again — the regeneration re-records the prerequisite versions,
which is what lets a document that fell behind catch up.

## Composition

`compose` is deterministic and complete. Our Understanding assigns requirements to
its fifteen template sections — by category where Phase 4 already classified them,
by the words the requirements use where a heading is not a category — and writes a
plain body citing each requirement key. Feature Listing builds one row per
non-overhead estimate unit, copying the unit's hours.

A model then rewrites the section bodies, or names the modules and screens. It
cannot add a section, change a number, cite a requirement it was not given, or
invent a source location. Those are properties of the schemas in
`document-schemas.ts`, not of the prompts.

## Edit protection

A section's `origin` is `GENERATED`, `USER_EDITED` or `USER_AUTHORED`. Regeneration
replaces the first and _proposes_ over the other two: the body stays, the new text
lands in `proposedBody`, and a pending proposal is a blocker. Resolving it keeps the
section protected whichever option was chosen — accepting a rewrite is still a
person's decision, and the next regeneration must ask again.

Feature rows are matched across regenerations on the estimate unit behind them,
which is a row's identity. Descriptive edits carry forward; hours always come from
the new composition, because they come from the estimate.

## Correction instructions

A correction is a recorded event, not a parameter. `document_corrections` holds the
instruction, what it targeted (`DOCUMENT`, `SECTION`, `FEATURE`, `MODULE`), the
version it was made against, the run that carried it out, the version it produced
and its outcome (`APPLIED`, `PROPOSED`, `NOT_APPLIED`). The record is written
_before_ the run, so a failed attempt still leaves the request on the record.

The instruction travels in the **evidence** channel, wrapped in the same delimiters
as a client's requirement text, and is never interpolated into a system prompt. The
reasons it cannot reach upstream authority are structural rather than behavioural:

- a section may cite only requirement ids the run was handed, and the citation
  check rejects the rest before storage;
- a technology outside the locked stack is a BLOCKING validation finding;
- no generation schema has an effort field, so no instruction can produce hours;
- nothing in the document engine writes to the baseline, the stack or the estimate.

`correctionLimits` reports which parts of a request cannot have the effect the user
expects — advisory, and deliberately not a filter: a request that mentions a
technology in passing is legitimate, and refusing it would be worse than explaining
the limit.

`correctionAuditMetadata` carries the target, the instruction _length_ and the
outcome. Never the text: a correction can quote a client or describe commercially
sensitive scope, and an audit record has to be safe to hand over.

## Targeted regeneration

`regenerateFeatures` takes either feature ids or a module name. Rows outside the
selection are carried forward field for field — wording, review status, hours. The
model is asked for wording only, through the same `document.features` schema that
has no effort field, and the engine copies effort, estimate-unit references and
technologies from the row rather than from the response. A response that tries to
return hours fails `.strict()` as a whole and the rows keep what they had.

A row whose `reviewStatus` is not `GENERATED` gets a `proposed` object instead of a
replacement, and a pending row proposal is an approval blocker exactly as a pending
section proposal is.

## The issued lifecycle

`APPROVED` means agreed and unlocks dependents. `FINAL` means issued — the document
left the building — and this project uses "issued" in the interface for exactly that
reason. `DOCUMENT_TRANSITIONS.FINAL` is empty: an issued _version_ has no exits, and
edits, regeneration, restoration and re-issuing are all refused against one.

Revising an issued document creates a **new version**. The issued version keeps its
`FINAL` status and its content in `document_versions`, which is what makes "what did
the client receive?" answerable; the new version starts as a copy in `DRAFT` with
every section marked `USER_EDITED`, because somebody chose that text when they
issued it. `reopen` on an issued document routes to `revise`, so there is one
mental model rather than two.

Revising re-stamps the new working version with today's upstream versions and clears
its validation. The text was carried across unread, so nothing about it claims to
match the new baseline — the cleared validation is what makes that claim impossible
to skip, and approval requires a fresh one whose coverage and citation checks run
against the current baseline. Revising opens a version to work in; it does not
launder staleness. If the baseline itself has not been re-approved, the new working
version is reported out of date too, which is the honest answer.

Approval and issuing both refuse while a document is not current, with
`DOCUMENT_UPSTREAM_STALE`, checked before the transition table so the message names
the real cause. Regeneration, by contrast, is _allowed_ on a stale approved
document — it is the action the screen tells the user to take.

## Two axes: lifecycle status and currentness

A document has a **status** — what people decided — and a **currentness** — whether
the world has moved since. They are separate fields because a document can be both
issued and stale, and both facts matter:

```
  status      = FINAL       the immutable version that was sent to the client
  currentness = OUTDATED    the project has changed since it was sent
```

When `OUTDATED` was a status, that combination could not be expressed and the engine
had to pick a lie: relabel the issued document, so the history no longer says what
was sent, or leave it saying `FINAL` and drop the fact that the project moved. The
first was rejected, which meant issued documents silently stopped reporting upstream
changes at all.

`DOCUMENT_STATUSES` therefore has eight values and no `OUTDATED`.
`DOCUMENT_CURRENTNESS` is `CURRENT | OUTDATED`, derived on every read from the
upstream versions the content was written against — never stored as truth, never set
by a user, and computed by one shared function, `documentOutdatedReasonsFor`, so the
list and the detail cannot disagree.

Separating the axes deleted special cases rather than adding them:

- an approved-but-stale document is `APPROVED` + `OUTDATED` — still approved,
  because nobody withdrew that, and still editable and regenerable, which is what
  the screen advises. `canGenerateDocument('APPROVED')` is now simply true, where
  the engine used to synthesise a fake `OUTDATED` status to get past its own check;
- `isAuthoritativeState` asks for both — an approved prerequisite whose own inputs
  moved does not unlock the document after it, so staleness cannot travel down the
  chain unannounced;
- `canApproveDocument` and `canIssueDocument` ask for both, so nothing stale is
  approved or issued;
- versions in the history carry their own currentness, judged against today's
  upstream from the versions recorded with each one. That is what lets the history
  say "the version issued in March is no longer current" without touching the March
  document.

## Three content channels, not five

A document fills the channel its shape calls for: `sections` for prose,
`features` for the Feature Listing, `rows` for every other list document.

Three rather than one because feature rows are genuinely different — they carry
authoritative hours copied from the approved estimate, reconciled against it on
every read, with an eight-column export format pinned by contract. Folding them into
an opaque payload would lose the checks that make them safe.

Three rather than five because everything after the Feature Listing shares one
envelope. `document-row.contract.ts` carries what the _engine_ needs — identity,
order, origin, a pending proposal, citations, an exclusion reason — and a `payload`
each document's own Zod schema parses before anything is stored. Adding the Work
Breakdown Structure is a composer, a row kind and a payload schema; it is not a
collection, a mapper branch and a set of endpoints.

`DOCUMENT_ROW_KIND_BY_TYPE` maps a `ROWS` document to its row kind. A composer
declares `rowKind` when it uses the shared channel, and `mayBeEmpty` when an empty
document is a legitimate result — Assumptions is the only one, and without that flag
the blocker calculation reads "no content" as "not generated" and refuses to approve a
document that is exactly right.

## The authority chain is data

`UpstreamContext.documents` carries the content of earlier documents, and a document
appears there **only** when it is approved or issued _and_ current — the reader
applies `isAuthoritativeState` before filling it in.

That single condition is the sequential rule and the currentness rule at once. A
composer for document 5 that finds `assumptions: null` has nothing to build on and
cannot quote a draft by accident, so the rule does not have to be remembered in five
places.

`UpstreamContext.timeline` is the same idea for the schedule: `basis` decides whether
a document may name a date at all, and it comes from Phase 6 and the project's own
start-date mode rather than from a composer's guess.

## What each Phase 8 document may and may not do

**Acceptance Criteria** composes one criterion per feature per aspect the requirement
actually states — `aspectsFor` reads the requirement's own words, and is deliberately
conservative because a condition the evidence does not support is worse than a missing
one. `UNSTATED_THRESHOLD_PATTERNS` compares any figure or standard in a criterion
against the approved requirement text; a figure that appears only in the criterion is
BLOCKING, not a warning, because warnings get acknowledged and ship.

**Assumptions** composes only from clarifications the user marked `isAssumption` in
Phase 4 — a recorded decision rather than an inference. Model output goes through
`assumptionCandidateSchema`, which has no field for `status`, `provenance`, `owner` or
`confirmedBy`, so a model cannot express an authoritative assumption.
`candidateToAssumption` is the only path from a suggestion to a row and supplies every
authoritative field itself. `openQuestionsTreatedAsAssumptions` catches the specific
failure the document exists against: an assumption whose words restate a question
nobody answered.

**Statement of Work** transcribes. `MODEL_WRITABLE_SOW_SECTIONS` excludes
`technology`, `timeline`, `milestones` and `assumptions` — those quote approved
artifacts, and "improving" one means changing a version, a date or a status by
rewording it. `PROHIBITED_LEGAL_PATTERNS`, `INTERNAL_METHODOLOGY_PATTERNS`,
`STAFFING_CLAIM_PATTERNS`, `inventedDates` and `reconcileSowScope` are all BLOCKING.
`OUTSTANDING_COMMERCIAL_TERMS` names what is missing as categories rather than clause
names — writing "governing law" to say it is absent would put clause language into the
document and trip the legal check, and a checker that exempted its own text would have
a hole in it.

Row edits are bounded by `rewritableFields`: wording only. An acceptance criterion's
requirement and feature links do not change by rewording, because what a criterion is
_about_ is a scope decision; an assumption's status and provenance do not change by
editing, because those move only through confirm, reject and settle, where the
application records who did it.

## Traceability lives in the citation, not in the prose

A section's body reads as a document a client could be sent. The requirement it came
from is on `section.references`, which is what the interface shows under "Where this
comes from" and what `technicalDocumentText` appends. Nothing writes `REQ-014:` into
a sentence.

Validation follows from that. Coverage is computed against the recorded citations,
not against ids scraped out of the text — a scrape would report every requirement as
uncovered the moment a model rewrote a section, since model prose carries no ids at
all. The prose is still read, for the opposite question: an id that appears in it and
is not in the baseline is a fabricated citation, and that is caught wherever it
turns up.

## Clipboard

`clientDocumentText` builds the copy from titles and bodies, and nothing else — no
requirement ids, no source references, no confidence figures, no section keys, no
statuses. Empty sections are dropped rather than pasted with our own explanation
underneath. A line opening with a citation prefix (`REQ-014: Staff must sign in.`)
loses the prefix and keeps the sentence; an id written _inside_ a reviewer's own
sentence is left alone and reported, because rewriting what somebody wrote to hide an
identifier would change what the document says. `technicalDocumentText` adds requirement keys and is reached by a
separate control, so the client-facing copy cannot accidentally become the technical
one. `leaksInternalData` checks for the _shapes_ of our identifiers and is asserted
by both the contract tests and the browser suite.

Feature Listing copies the strict CSV verbatim from the same serialiser the export
uses, so there is no second formatting path to drift.

## Adding a source during review

There is no uploader in the document engine, and no route that would accept one. The
documents step offers "Add supporting source", which navigates to the
requirement-input step — Phase 3's uploader, Phase 4's analysis, a re-approved
baseline, and then Phase 7's outdated propagation. A document-local evidence source
would be evidence nothing else in the application had agreed to.

## Storage

Six collections. `documents` holds current state and the assessment approval reads.
`document_sections` and `document_features` are per-row, so editing one paragraph is
a small write with its own optimistic concurrency. `document_versions` holds
immutable snapshots — the one place content is denormalised, and the place where
that is correct. `document_generation_runs` and `document_validation_results` are
records: sizes, timings, prompt versions, severities. Never requirement text, never
a prompt, never document prose. `document_corrections` holds what a reviewer asked
for — project content under the same session authority as a requirement, and never
copied into an audit record.

A document is never embedded in the project record. Seven documents with fifteen
sections and up to two thousand rows would make every unrelated project read
expensive.

The repository stamps `projectId` and `type` onto section and feature rows itself
rather than trusting callers — every row in those collections is scoped by them, and
a caller that forgets writes a section belonging to nothing.

## Reading is recomputing

`assemble` recomputes currentness, coverage, reconciliation and blockers on every
read, exactly as Phase 6 does with the estimate. All of them are functions of stored
data and the current upstream state, and storing them without recomputing is how a
stale "everything is fine" survives a change upstream.

The status is the one thing `assemble` does **not** compute: it is what somebody
decided, and it is returned exactly as stored. Currentness is derived beside it, so
neither is written over the other and no background job can be the reason a document
misreports itself.

## Validation

Deterministic findings are authoritative. `MODEL_RAISABLE_KINDS` limits a model to
four judgement kinds, and every model finding is a `WARNING` labelled
`detectedBy: 'MODEL'`. Approval requires a validation result belonging to the
_current_ version with no blocking finding — ADR-0034.

`PASS` findings are kept. "Coverage is complete" and "the hours match the estimate"
are the two things a reviewer most wants confirmed, and an empty list confirms
nothing.

## Working without a model

`AI_PROVIDER=disabled` is a supported configuration. Generation, section rewriting,
validation and approval all work; the prose is plainer. `DocumentsAiService` takes
the provider `@Optional()`, so the module starts normally with none, and
`useAi: false` is a first-class request rather than a fallback.

## Known limitations

- **Five of seven documents are declared, not implemented.** They are visible and
  marked unavailable; nothing can generate, read or approve them.
- **Export is Phase 11.** Copy-to-clipboard and the strict CSV serialisation exist
  because the CSV schema is a Phase 7 requirement. DOCX, PDF and XLSX do not.
- **The deterministic module and screen names are crude** — derived from the
  requirement's own words. A model does this far better; what matters is that the
  fallback is derived rather than invented.
- **The forbidden-content list is a denylist**, and a denylist is never complete. It
  catches the phrases this failure mode actually produces; the general defence is
  that a section may only cite requirements it was given.
