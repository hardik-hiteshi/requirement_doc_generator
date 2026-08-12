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

Idempotent: an index that is not there reports as already gone, which is the expected
result on a database created at Phase 10 or later.

The replacement indexes — `(projectId, type, documentVersion, id)`, unique — are created
automatically wherever `autoIndex` is on, and should be created as part of your deployment
process where it is off (production defaults to off).

## Checking

```js
db.document_sections.getIndexes().map((index) => index.name);
```

Expect a compound index ending in `documentVersion_1_sectionId_1`, and no bare
`sectionId_1`.
