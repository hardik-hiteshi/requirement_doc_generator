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

/** Empties both suite databases. Safe to call while the API is running. */
export async function resetTestData(): Promise<void> {
  for (const databaseName of [DATABASE_NAME, PRODUCTION_DATABASE_NAME]) {
    await withDatabase(databaseName, async (db) => {
      await db.collection('projects').deleteMany({});
      await db.collection('audit_events').deleteMany({});
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
