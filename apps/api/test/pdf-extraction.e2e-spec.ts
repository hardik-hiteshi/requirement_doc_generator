import { REQUIREMENT_ROUTES } from '@wdrg/contracts';

import { startIngestionHarness, type IngestionHarness } from './ingestion-harness';

/**
 * Every test that puts a PDF through the pipeline, and nothing else.
 *
 * This file is the *only* member of a dedicated Jest project — see
 * `jest.pdf.config.ts`. pdfjs is ESM-only and the extractor reaches it through
 * `new Function('specifier', 'return import(specifier)')`, because a literal
 * `import()` is rewritten to `require()` by the transpiler and cannot load an ES
 * module. A function built that way has no module referrer, so Jest cannot
 * attribute the import to the file that made it and falls back to the runtime it
 * registered most recently. In a process where another suite has already
 * finished, that runtime is torn down, the import throws, and the extraction job
 * is requeued with backoff — leaving a source at QUEUED and a test failing for a
 * reason that has nothing to do with PDFs.
 *
 * Its own project, its own process, one file: nothing can have been torn down
 * before it runs, whatever order the rest of the suites are in. `test-topology`
 * asserts that invariant so it cannot rot.
 */
describe('PDF extraction (e2e)', () => {
  let harness: IngestionHarness;

  beforeAll(async () => {
    harness = await startIngestionHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  describe('upload validation', () => {
    it('accepts a genuine PDF and queues it', async () => {
      const session = await harness.newProject();
      const response = await harness.uploadFixture(session, 'requirements-digital.pdf');

      expect(response.status).toBe(201);
      expect(response.body.outcomes[0].accepted).toBe(true);
      expect(response.body.outcomes[0].source.status).toBe('QUEUED');
      // The storage address is an internal detail and must never be returned.
      expect(JSON.stringify(response.body)).not.toContain('storageObjectId');
    });

    it.each([
      ['mismatch.pdf', 'invoice.pdf', 'SIGNATURE_MISMATCH'],
      ['password-protected.pdf', 'secret.pdf', 'PASSWORD_PROTECTED'],
    ])('refuses %s as %s', async (name, as, code) => {
      const session = await harness.newProject();
      const response = await harness.uploadFixture(session, name, as);

      expect(response.body.outcomes[0].accepted).toBe(false);
      expect(response.body.outcomes[0].errorCode).toBe(code);
      expect(response.body.outcomes[0].errorMessage).toBeTruthy();
    });
  });

  describe('extraction', () => {
    it('reads a digital PDF with page traceability', async () => {
      const { source } = await harness.uploadAndExtract('requirements-digital.pdf');

      expect(['READY', 'REVIEW_REQUIRED']).toContain(source.status);
      expect(source.effectiveContent.pageCount).toBe(1);
      expect(source.effectiveContent.blocks[0].reference.pageNumber).toBe(1);
      expect(source.effectiveContent.usedOcr).toBe(false);
    });

    it('routes a scanned PDF through OCR and flags it for review', async () => {
      const { source } = await harness.uploadAndExtract('requirements-scanned.pdf');

      expect(source.status).toBe('REVIEW_REQUIRED');
      expect(source.effectiveContent.usedOcr).toBe(true);
      expect(source.effectiveContent.warnings.map((w: { code: string }) => w.code)).toContain(
        'IMAGE_ONLY_PAGES',
      );
    }, 120_000);

    it('fails a corrupted file with a safe message and no internals', async () => {
      const { source } = await harness.uploadAndExtract('corrupted.pdf');

      expect(source.status).toBe('FAILED');
      expect(source.failureCode).toBe('CORRUPTED_FILE');
      expect(source.failureMessage).not.toMatch(/stack|at |node_modules|\/home\//i);
    });
  });

  describe('retry', () => {
    it('refuses to retry a permanent failure, which retrying cannot fix', async () => {
      const { session, sourceId } = await harness.uploadAndExtract('corrupted.pdf');

      await session.agent
        .post(REQUIREMENT_ROUTES.retry(sourceId))
        .set('x-csrf-token', session.csrf)
        .expect(409);
    });
  });
});
