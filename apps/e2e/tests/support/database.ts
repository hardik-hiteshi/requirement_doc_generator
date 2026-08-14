import { MongoClient, type Db } from 'mongodb';

import { DATABASE_NAME, mongoUri, PRODUCTION_DATABASE_NAME } from './environment';

/**
 * Direct database access, for the two things HTTP cannot express.
 *
 * 1. Resetting the suite's data between runs, so a scenario never inherits state
 *    from a previous one.
 * 2. Ageing a project past its expiry. There is no endpoint for that — expiry is
 *    a timestamp the application only ever reads — so the honest options are a
 *    fake clock or a fixture. A fixture is used because it changes one field on
 *    one project and leaves the application's real clock alone.
 *
 * Documents are removed rather than the database dropped: dropping would take
 * the indexes with it, and the API creates those once at startup.
 */

async function withDatabase<T>(databaseName: string, work: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(mongoUri(databaseName), { serverSelectionTimeoutMS: 15_000 });

  try {
    await client.connect();
    return await work(client.db(databaseName));
  } finally {
    await client.close();
  }
}

/**
 * Empties both suite databases. Safe to call while the API is running.
 *
 * Every collection, not a chosen few. Clearing only `projects` and `audit_events`
 * left everything they point at behind, so a long-lived database accumulated the
 * content of every run ever made against it — tens of thousands of sections, rows
 * and estimate units that no project referenced any more. That is slow to query
 * and, worse, it means a scenario can inherit state this function promises it
 * cannot.
 *
 * Emptying rather than dropping, which is the original reasoning and still holds:
 * a dropped collection takes its indexes with it, and the API creates those once
 * at startup. An index that is no longer declared is a different problem, and a
 * documented manual migration — see docs/operations/schema-changes.md — rather
 * than something to do behind an operator's back on every test run.
 */
export async function resetTestData(): Promise<void> {
  for (const databaseName of [DATABASE_NAME, PRODUCTION_DATABASE_NAME]) {
    await withDatabase(databaseName, async (db) => {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();

      await Promise.all(
        collections
          .map((collection) => collection.name)
          .filter((name) => !name.startsWith('system.'))
          .map((name) => db.collection(name).deleteMany({})),
      );
    });
  }
}

/**
 * Proves the reset actually did what it claims, before any scenario runs.
 *
 * Two things, because both have been wrong. Anything left behind is state a scenario
 * could inherit — and the reason this is asserted rather than assumed is that clearing
 * two collections out of twenty-seven looked exactly like working. And the indexes must
 * survive the clearing: content ids are unique per document version, and a database
 * missing that index would let a defect through, while one carrying the obsolete
 * globally-unique version silently loses content instead of reporting a conflict.
 *
 * Failing here aborts the run before the first test, which is the useful place to find
 * out: a contaminated database produces failures that look like product defects.
 */
export async function assertCleanSlate(): Promise<void> {
  const CONTENT_IDS = [
    ['document_sections', 'sectionId'],
    ['document_features', 'featureId'],
    ['document_rows', 'rowId'],
  ] as const;

  for (const databaseName of [DATABASE_NAME, PRODUCTION_DATABASE_NAME]) {
    await withDatabase(databaseName, async (db) => {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      const names = collections
        .map((collection) => collection.name)
        .filter((name) => !name.startsWith('system.'));

      const inherited: string[] = [];

      for (const name of names) {
        const count = await db.collection(name).countDocuments();

        if (count > 0) {
          inherited.push(`${name} (${count})`);
        }
      }

      if (inherited.length > 0) {
        throw new Error(
          `${databaseName} still holds data a scenario could inherit: ${inherited.join(', ')}.`,
        );
      }

      for (const [collection, field] of CONTENT_IDS) {
        if (!names.includes(collection)) {
          continue;
        }

        let indexes = await db.collection(collection).indexes();
        const scoped = `projectId_1_type_1_documentVersion_1_${field}_1`;

        /*
         * The scoped index is only expected where the application creates indexes.
         *
         * `autoIndex` is off in production, deliberately, and one of the two servers this
         * suite starts runs in production mode — so its database has whatever a deployment
         * would have created, which here is nothing. Demanding the index there fails the
         * run over a database no document scenario touches.
         */
        if (databaseName === DATABASE_NAME) {
          /*
           * Waited for rather than demanded instantly.
           *
           * Mongoose builds indexes in the background after connecting, and the servers are
           * started before this runs — so on a database that did not already have them, the
           * collection can exist a moment before its index does. Asserting immediately turns
           * that ordinary startup ordering into a failed run, which is what happened on a
           * fresh hosted database while every warm local one passed. The property being
           * protected is that the reset did not drop the index, and waiting a bounded moment
           * still proves it: the index either arrives or it genuinely is not there.
           */
          const deadline = Date.now() + 30_000;

          while (!indexes.some((index) => index.name === scoped) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            indexes = await db.collection(collection).indexes();
          }

          if (!indexes.some((index) => index.name === scoped)) {
            throw new Error(
              `${databaseName}.${collection} is missing ${scoped}: reset dropped it.`,
            );
          }
        }

        /*
         * The obsolete index is checked everywhere, because this one does damage. It
         * cannot appear by itself — only by being carried over from before Phase 10 — and
         * wherever it is, content is silently lost instead of a conflict being reported.
         */
        const globallyUnique = indexes.find(
          (index) => index.unique === true && Object.keys(index.key).length === 1,
        );

        if (globallyUnique) {
          throw new Error(
            `${databaseName}.${collection} carries ${String(globallyUnique.name)}, which is ` +
              'unique across every version and will silently lose content. See ' +
              'docs/operations/schema-changes.md.',
          );
        }
      }
    });
  }
}

/** Moves a project's expiry into the past, as if it had been abandoned. */
export async function expireProject(projectId: string): Promise<void> {
  const result = await withDatabase(DATABASE_NAME, (db) =>
    db
      .collection('projects')
      .updateOne(
        { projectId },
        { $set: { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      ),
  );

  if (result.matchedCount !== 1) {
    throw new Error(`Cannot expire ${projectId}: no such project in ${DATABASE_NAME}.`);
  }
}

/** The stored project document, for assertions that must look past the API. */
export async function readProjectDocument(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  return withDatabase(DATABASE_NAME, (db) =>
    db.collection('projects').findOne<Record<string, unknown>>({ projectId }),
  );
}

/** Audit event types recorded for a project, oldest first. */
export async function readAuditEventTypes(projectId: string): Promise<string[]> {
  return withDatabase(DATABASE_NAME, async (db) => {
    const events = await db
      .collection('audit_events')
      .find<{ type: string }>({ projectId }, { projection: { type: 1 }, sort: { occurredAt: 1 } })
      .toArray();

    return events.map((event) => event.type);
  });
}

/** Every document in both collections, serialised. Used to hunt for a secret. */
export async function dumpAllDocuments(): Promise<string> {
  const parts: string[] = [];

  for (const databaseName of [DATABASE_NAME, PRODUCTION_DATABASE_NAME]) {
    await withDatabase(databaseName, async (db) => {
      for (const collection of ['projects', 'audit_events']) {
        const documents = await db.collection(collection).find({}).toArray();
        parts.push(JSON.stringify(documents));
      }
    });
  }

  return parts.join('\n');
}
