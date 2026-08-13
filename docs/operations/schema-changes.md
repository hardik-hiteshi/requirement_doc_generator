# Schema changes that need a hand

Mongoose creates the indexes a schema declares. It **never drops one it has stopped
declaring**. So a change that narrows or removes an index leaves the old one in place on
every database that already exists — and an old unique index goes on rejecting writes the
new schema considers perfectly legal.

Nothing here is automated. Dropping indexes on boot means a process that starts twice in
parallel is dropping indexes twice, and a generic "remove anything the schemas do not
declare" would eventually remove an index somebody added deliberately for a slow query.
Both are worse than a documented step that an operator runs once, deliberately, with the
database in front of them.

A **fresh** database needs none of this: it is created from the current schema. This
matters only when upgrading an installation that already has data.

## Phase 10 — document content ids became unique per version

Document sections, feature rows and generic rows used to carry globally unique ids. As of
Phase 10 they are unique within a document _version_, so content keeps its identity when a
new version is cut — see [ADR-0040](../adr/0040-a-version-per-change.md).

The old indexes must go, or the second version of any document fails to save: the old
index insists an id can appear once in the whole collection, and the new model deliberately
repeats it across versions.

Symptom, if you skip this:

```
E11000 duplicate key error collection: <db>.document_sections index: sectionId_1
```

Run once, against the application's database, while the API is stopped or idle:

```js
// mongosh "<your MONGODB_URI>"
for (const [collection, index] of [
  ['document_sections', 'sectionId_1'],
  ['document_features', 'featureId_1'],
  ['document_rows', 'rowId_1'],
]) {
  try {
    db.getCollection(collection).dropIndex(index);
    print(`dropped ${index}`);
  } catch (error) {
    print(`${index} already gone`);
  }
}
```

Safe to re-run. Each drop is attempted independently and a missing index reports as
already gone, so running it twice — or on a database created at Phase 10 or later, or
after a half-finished attempt — leaves the same result and fails nothing. It does not
touch data, and it creates nothing.

The replacement indexes — `(projectId, type, documentVersion, id)`, unique — are created
automatically wherever `autoIndex` is on, and should be created as part of your deployment
process where it is off (production defaults to off).

### What changes

Per collection, before and after:

| Collection          | Must be gone  | Must exist                                         |
| ------------------- | ------------- | -------------------------------------------------- |
| `document_sections` | `sectionId_1` | `projectId_1_type_1_documentVersion_1_sectionId_1` |
| `document_features` | `featureId_1` | `projectId_1_type_1_documentVersion_1_featureId_1` |
| `document_rows`     | `rowId_1`     | `projectId_1_type_1_documentVersion_1_rowId_1`     |

Everything else is left alone — the non-unique `sectionId_1`-style lookup indexes the
current schema still declares, the `order` indexes, and anything added by hand.

Uniqueness is narrowed, not removed. After the migration a section id may appear once per
version of one document, and a second row claiming the same id inside the same version is
still rejected with E11000. `apps/api/test/document-indexes.e2e-spec.ts` asserts both
halves, so a future schema change cannot quietly drop the protection instead of scoping it.

### Verifying

```js
// mongosh "<your MONGODB_URI>"
for (const [collection, field] of [
  ['document_sections', 'sectionId'],
  ['document_features', 'featureId'],
  ['document_rows', 'rowId'],
]) {
  const names = db
    .getCollection(collection)
    .getIndexes()
    .map((index) => index.name);
  const obsolete = names.includes(`${field}_1`);
  const scoped = names.includes(
    `projectId_1_type_1_documentVersion_1_${field}_1`,
  );
  print(`${collection}: ${!obsolete && scoped ? 'ok' : 'NEEDS ATTENTION'}`);
}
```

Three `ok` lines and the database is ready.

### If something goes wrong

Dropping an index cannot lose data, so recovery is to recreate what was dropped:

```js
db.document_sections.createIndex(
  { sectionId: 1 },
  { unique: true, name: 'sectionId_1' },
);
```

That puts the database back to its Phase 9 shape, where Phase 9 code runs and Phase 10
code cannot save a second document version. Recreating it is therefore a step backwards to
take alongside rolling the application back, not a fix on its own.

One case does need care: if a Phase 10 application has already written more than one
version of a document, the old unique index can no longer be created — the repeated ids it
forbids are legitimately there. Recreating it then requires removing the superseded
versions first, which discards history. Take a database backup before the migration and
restore that instead.
