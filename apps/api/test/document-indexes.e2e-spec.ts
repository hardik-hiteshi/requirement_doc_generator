import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';

import { AppModule } from '../src/app.module';

/**
 * The shape of the indexes that make a version history possible.
 *
 * Phase 10 gives a section, feature row or generic row an identity that survives a
 * new version being cut: the same `sectionId` appears once per version, which is what
 * lets a comparison line up "this section, before and after". A globally unique index
 * on that id contradicts the model outright — the second version of any document
 * fails to save with E11000, and because the write that fails is the one that re-keys
 * the content, the document loses the section entirely rather than reporting an error
 * the user can act on.
 *
 * That is exactly what happened on a database carried over from Phase 9, and it is
 * silent enough to be worth a test rather than a note: the schema is correct, so the
 * only evidence is the index list on the collection.
 *
 * Asserted against a live connection rather than the schema objects, because the
 * question is what the database ended up with, which is what the defect turned on.
 */
describe('Document content indexes (e2e)', () => {
  /* Collection, the id it keys content by, and the obsolete index that must be gone. */
  const CONTENT = [
    ['document_sections', 'sectionId'],
    ['document_features', 'featureId'],
    ['document_rows', 'rowId'],
  ] as const;

  let connection: Connection;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    connection = app.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await connection?.close();
  });

  async function indexNames(collection: string): Promise<string[]> {
    const indexes = await connection.collection(collection).indexes();

    return indexes.map((index) => String(index.name));
  }

  it.each(CONTENT)('keys %s by version and id together', async (collection, field) => {
    expect(await indexNames(collection)).toContain(
      `projectId_1_type_1_documentVersion_1_${field}_1`,
    );
  });

  it.each(CONTENT)('does not make %s.%s unique across the whole collection', async (collection) => {
    const indexes = await connection.collection(collection).indexes();

    /*
     * Named or not: what matters is that no unique index covers the id on its own,
     * however it came to exist. `dropIndex` in the documented migration goes by name;
     * this goes by shape, so an index somebody recreated under another name is caught.
     */
    const globallyUnique = indexes.filter(
      (index) => index.unique === true && Object.keys(index.key).length === 1,
    );

    expect(globallyUnique.map((index) => index.name)).toEqual([]);
  });

  it.each(CONTENT)(
    'lets one %s id repeat across versions but not within one',
    async (collection, field) => {
      const scope = { projectId: `idx-${field}`, type: 'OUR_UNDERSTANDING' };
      const identity = { ...scope, [field]: `${field}-1` };

      await connection.collection(collection).deleteMany(scope);

      /* The same content, carried forward as new versions are cut. */
      await connection
        .collection(collection)
        .insertMany([1, 2, 3].map((documentVersion) => ({ ...identity, documentVersion })));

      await expect(
        connection.collection(collection).insertOne({ ...identity, documentVersion: 3 }),
      ).rejects.toMatchObject({ code: 11000 });

      expect(await connection.collection(collection).countDocuments(identity)).toBe(3);

      await connection.collection(collection).deleteMany(scope);
    },
  );
});
