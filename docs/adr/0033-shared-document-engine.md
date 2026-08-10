# 33. One document engine, seven documents

Date: 2026-08-10

Status: Accepted

## Context

Seven controlled documents are in scope: Our Understanding, Feature Listing,
Acceptance Criteria, Assumptions, Statement of Work, Work Breakdown Structure,
Client Dependency Sheet. Phase 7 implements the first two.

Every one of them needs the same machinery. A status that distinguishes draft from
approved from issued. Versions that stay readable after they are superseded.
Regeneration that does not overwrite what a person wrote. A dependency graph, so a
change upstream marks the right documents out of date. Validation with findings a
reviewer can act on. Approval, reopening, audit, storage.

The obvious way to build the first two is to build the first two: a service and a
controller for Our Understanding, another for Feature Listing. By document five
there are five status machines that have drifted apart, five approval checks with
subtly different rules, and a bug fixed in three of them.

## Decision

**One engine, and a composer per document.**

`DocumentsService` owns everything that is true of all documents:

- the status table and refusing a transition that is not in it;
- versioning, archiving, comparing and restoring;
- edit protection and the proposal flow;
- the dependency graph, locking and outdated propagation;
- validation orchestration, approval, reopening and issuing;
- audit records carrying document metadata and never document prose.

`DocumentComposer` owns what is true of one document:

```ts
interface DocumentComposer {
  readonly type: DocumentType;
  readonly shape: DocumentShape;
  readonly requiredSectionKeys: readonly string[];
  compose(context: UpstreamContext): ComposedContent;
  validate(input: ValidationInput): readonly ValidationFinding[];
  applicableRequirementIds(context: UpstreamContext): readonly string[];
}
```

Adding Acceptance Criteria is a composer and a row in `DOCUMENT_DEPENDENCIES`. No
new service, controller, repository, endpoint or status machine — and the API does
not grow a route, because the document type is a path parameter.

**All seven types are declared; two are implemented.** The graph, the UI's step
list and the propagation rules all need to know what exists eventually, and
discovering document five while building it is how an engine acquires a special
case per document. `IMPLEMENTED_DOCUMENT_TYPES` is the honest half: anything
outside it cannot be generated, read, validated or approved, and the UI shows it
as unavailable rather than as a button that fails.

**One snapshot shape for both document kinds.** A `SECTIONS` document fills
`sections`; a `ROWS` document fills `features`. Two shapes would mean two of every
endpoint, and the difference between a prose document and a table is data rather
than architecture.

**Composition is deterministic.** `compose` takes no provider and cannot make a
network call. It produces a complete document from the approved artifacts alone —
every heading, the requirements each one covers, every feature row with its hours.
The model's contribution is prose _inside_ a structure the application already
decided. That is what makes `AI_PROVIDER=disabled` a working configuration rather
than a degraded one, and it is why a model failure during generation degrades
readability and nothing else.

## Consequences

The engine is large, and it is the only large file. A reviewer looking for "how
does approval work" reads one method rather than comparing five.

A composer cannot do anything unusual. If a later document needs a status the
table does not have, or a validation the severities cannot express, the engine
changes — deliberately, once, for all seven. That is the trade: the cost of a
genuinely new requirement is a change in a shared place, and the benefit is that
five documents cannot quietly diverge.

`UpstreamReader` is separate from the engine, so the engine has no opinion about
where authority comes from. It also means Phase 4's lazy outdated check runs for
documents, which Phases 5 and 6 both had to learn to do.

The composers are Nest providers rather than plain objects, so a later document
can inject what it needs without changing the engine's constructor.
