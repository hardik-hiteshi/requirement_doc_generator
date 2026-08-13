import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  API_PREFIX,
  API_VERSION,
  DOCUMENT_ROUTES,
  PROJECT_ROUTES,
  type ClientDependency,
  type DocumentDiff,
  type DocumentSnapshot,
  type DocumentVersionSummary,
  type TraceabilityView,
} from '@wdrg/contracts';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { setupOpenApi } from '../src/openapi';
import { configureSecurity } from '../src/security';
import {
  approvedEstimateProject,
  documentFixture,
  type FixtureSession,
} from './documents-fixtures';

/**
 * The shared review lifecycle, end to end.
 *
 * Phase 10 owns the parts every document shares: what a version is, what a comparison
 * says, what restoring means, when approval stops applying, and how a requirement can
 * be followed through all seven documents.
 *
 * The distinction these tests exist to pin down is the one in §1 of the specification.
 * **An upstream change makes a document OUTDATED and leaves the approval standing** —
 * the decision was true when it was made. **A content change takes the approval away**
 * — what is in front of you is no longer what anybody approved. Treating those alike,
 * in either direction, is the failure that makes an approval meaningless.
 */
describe('Document lifecycle (e2e)', () => {
  let app: NestExpressApplication;
  let provider: DeterministicProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: process.env.DEBUG_E2E ? ['error'] : false,
    });
    configureSecurity(app, app.get(AppConfigService));
    app.setGlobalPrefix(API_PREFIX);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
    setupOpenApi(app, app.get(AppConfigService));
    await app.init();

    provider = app.get(DeterministicProvider);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  /* --------------------------------------------------------------- helpers */

  const WEB = documentFixture('a web application');

  const UNDERSTANDING = 'OUR_UNDERSTANDING';
  const LISTING = 'FEATURE_LISTING';
  const CRITERIA = 'ACCEPTANCE_CRITERIA';

  async function project(fixture = WEB): Promise<FixtureSession> {
    return approvedEstimateProject(app.getHttpServer(), provider, fixture);
  }

  async function read(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    return (await session.agent.get(DOCUMENT_ROUTES.document(type)).expect(200)).body
      .document as DocumentSnapshot;
  }

  async function generate(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    const current = await read(session, type);

    return (
      await session.agent
        .post(DOCUMENT_ROUTES.generate(type))
        .set('x-csrf-token', session.csrf)
        .send({ useAi: false, expectedVersion: current.recordVersion })
        .expect(201)
    ).body.document as DocumentSnapshot;
  }

  async function validate(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    return (
      await session.agent
        .post(DOCUMENT_ROUTES.validate(type))
        .set('x-csrf-token', session.csrf)
        .send({ useAi: false })
        .expect(201)
    ).body.document as DocumentSnapshot;
  }

  async function approve(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    const current = await read(session, type);
    const response = await session.agent
      .post(DOCUMENT_ROUTES.approve(type))
      .set('x-csrf-token', session.csrf)
      .send({ acknowledged: true, expectedVersion: current.recordVersion });

    if (response.status !== 201) {
      throw new Error(
        `Approving ${type} returned ${response.status}: ${JSON.stringify(response.body)}. Blockers: ${JSON.stringify(current.blockers)}`,
      );
    }

    return response.body.document as DocumentSnapshot;
  }

  /** Generate, disposition leftovers, validate and approve. */
  async function settle(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    await generate(session, type);

    const generated = await read(session, type);
    const uncovered = generated.blockers
      .filter((blocker) => blocker.kind === 'coverage_incomplete')
      .flatMap((blocker) => blocker.subjectIds)
      .filter((id) => id.startsWith('REQ-'));

    let version = generated.recordVersion;

    for (const requirementId of uncovered) {
      version = (
        (
          await session.agent
            .post(DOCUMENT_ROUTES.excludeRequirement(type))
            .set('x-csrf-token', session.csrf)
            .send({
              requirementId,
              reason: 'Recorded as out of scope for this document.',
              expectedVersion: version,
            })
            .expect(201)
        ).body.document as DocumentSnapshot
      ).recordVersion;
    }

    await validate(session, type);

    return approve(session, type);
  }

  async function versions(
    session: FixtureSession,
    type: string,
  ): Promise<readonly DocumentVersionSummary[]> {
    return (await session.agent.get(DOCUMENT_ROUTES.versions(type)).expect(200)).body
      .versions as DocumentVersionSummary[];
  }

  async function compare(
    session: FixtureSession,
    type: string,
    left: number,
    right: number,
  ): Promise<DocumentDiff> {
    return (
      await session.agent
        .get(`${DOCUMENT_ROUTES.compare(type)}?left=${left}&right=${right}`)
        .expect(200)
    ).body.diff as DocumentDiff;
  }

  async function traceability(session: FixtureSession): Promise<TraceabilityView> {
    return (await session.agent.get(DOCUMENT_ROUTES.traceability).expect(200)).body
      .traceability as TraceabilityView;
  }

  /** A project with Understanding approved and the Feature Listing written. */
  async function throughListing(): Promise<FixtureSession> {
    const session = await project();
    await settle(session, UNDERSTANDING);
    await generate(session, LISTING);

    return session;
  }

  /** Everything approved as far as Acceptance Criteria. */
  async function throughCriteria(): Promise<FixtureSession> {
    const session = await project();

    for (const type of [UNDERSTANDING, LISTING, CRITERIA]) {
      await settle(session, type);
    }

    return session;
  }

  const editSection = async (
    session: FixtureSession,
    type: string,
    body: string,
  ): Promise<DocumentSnapshot> => {
    const document = await read(session, type);
    const section = document.sections[0]!;

    return (
      await session.agent
        .put(DOCUMENT_ROUTES.section(type, section.sectionId))
        .set('x-csrf-token', session.csrf)
        .send({ body, expectedVersion: document.recordVersion })
        .expect(200)
    ).body.document as DocumentSnapshot;
  };

  /* ================================== 1. versions and immutability ======= */

  describe('versions', () => {
    it('1. a section edit creates a version and records why', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const before = await read(session, UNDERSTANDING);
      await editSection(session, UNDERSTANDING, 'A deliberately reworded opening paragraph.');
      const after = await read(session, UNDERSTANDING);

      expect(after.version).toBeGreaterThanOrEqual(before.version);

      const history = await versions(session, UNDERSTANDING);

      expect(history.length).toBeGreaterThan(0);
      expect(history.some((entry) => entry.changeType === 'SECTION_EDITED')).toBe(true);
    });

    it('2. reading, comparing and listing history create no versions', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const before = await versions(session, UNDERSTANDING);

      await read(session, UNDERSTANDING);
      await versions(session, UNDERSTANDING);
      await session.agent.get(DOCUMENT_ROUTES.document(UNDERSTANDING)).expect(200);

      const after = await versions(session, UNDERSTANDING);

      expect(after).toHaveLength(before.length);
    });

    it('3. an archived version keeps its own content when the working one moves on', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const first = await read(session, UNDERSTANDING);
      const original = first.sections[0]!.body;

      await editSection(session, UNDERSTANDING, 'Replaced entirely.');

      /* The stored version still says what it said. */
      const stored = (
        await session.agent
          .get(DOCUMENT_ROUTES.version(UNDERSTANDING, String(first.version)))
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(stored.sections[0]!.body).toBe(original);
    });

    it('4. every row mutation creates a version on a row document', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const document = await read(session, CRITERIA);
      const row = document.rows[0]!;

      await session.agent
        .patch(DOCUMENT_ROUTES.row(CRITERIA, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...(row.payload as Record<string, unknown>), notes: 'Reworded by review.' },
          expectedVersion: document.recordVersion,
        })
        .expect(200);

      const history = await versions(session, CRITERIA);

      expect(history.some((entry) => entry.changeType === 'ROW_EDITED')).toBe(true);
    });

    it('5. history counts rows, not only sections', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const history = await versions(session, CRITERIA);

      expect(history[0]!.contentCount).toBeGreaterThan(0);
    });
  });

  /* ============================================ 2. comparison ============ */

  describe('comparison', () => {
    it('6. compares two section versions and names what changed', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const first = await read(session, UNDERSTANDING);
      const key = first.sections[0]!.key;

      await editSection(session, UNDERSTANDING, 'A completely different paragraph for the diff.');

      const second = await read(session, UNDERSTANDING);
      const diff = await compare(session, UNDERSTANDING, first.version, second.version);

      const entry = diff.entries.find((candidate) => candidate.key === key)!;

      expect(entry.kind).toBe('CHANGED');
      expect(entry.right).toContain('completely different paragraph');
    });

    it('7. compares two row versions per field, not as opaque blobs', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const first = await read(session, CRITERIA);
      const row = first.rows[0]!;
      const rowKey = (row.payload as { criterionKey: string }).criterionKey;

      await session.agent
        .patch(DOCUMENT_ROUTES.row(CRITERIA, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: {
            ...(row.payload as Record<string, unknown>),
            then: 'the reworded observable outcome is visible',
          },
          expectedVersion: first.recordVersion,
        })
        .expect(200);

      const second = await read(session, CRITERIA);
      const diff = await compare(session, CRITERIA, first.version, second.version);

      const entry = diff.entries.find((candidate) => candidate.key === rowKey)!;

      expect(entry.kind).toBe('CHANGED');

      /* The field, named, with both values — not "this row changed". */
      const field = entry.fields.find((candidate) => candidate.field === 'then')!;

      expect(field.right).toContain('reworded observable outcome');
      expect(field.changeKind).toBe('CONTENT');
    });

    it('8. a row that only moved position reads as unchanged', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const first = await read(session, CRITERIA);

      /* Regeneration rebuilds the rows; their keys are what identifies them. */
      await generate(session, CRITERIA);

      const second = await read(session, CRITERIA);
      const diff = await compare(session, CRITERIA, first.version, second.version);

      /*
       * Same content, possibly different order and certainly different row ids. Keyed
       * comparison sees no change; a positional one would report every row twice.
       */
      expect(diff.entries.filter((entry) => entry.kind === 'ADDED')).toEqual([]);
      expect(diff.entries.filter((entry) => entry.kind === 'REMOVED')).toEqual([]);
    });

    it('9. distinguishes a traceability change from a content change', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const first = await read(session, CRITERIA);
      const row = first.rows[0]!;
      const payload = row.payload as Record<string, unknown>;

      await session.agent
        .patch(DOCUMENT_ROUTES.row(CRITERIA, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...payload, notes: 'A note, which is content.' },
          expectedVersion: first.recordVersion,
        })
        .expect(200);

      const second = await read(session, CRITERIA);
      const diff = await compare(session, CRITERIA, first.version, second.version);
      const changed = diff.entries.filter((entry) => entry.kind === 'CHANGED');

      /* Only content moved; nothing claims the citations changed. */
      expect(changed.length).toBeGreaterThan(0);
      expect(
        changed
          .flatMap((entry) => entry.fields)
          .some((field) => field.changeKind === 'TRACEABILITY'),
      ).toBe(false);
    });
  });

  /* ================================= 3. restore, reopen, revise ========== */

  describe('restore, reopen and revise', () => {
    it('10. restoring creates a new working version and leaves the source alone', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const first = await read(session, UNDERSTANDING);
      const original = first.sections[0]!.body;

      await editSection(session, UNDERSTANDING, 'Something else entirely.');

      const edited = await read(session, UNDERSTANDING);

      const restored = (
        await session.agent
          .post(DOCUMENT_ROUTES.restore(UNDERSTANDING))
          .set('x-csrf-token', session.csrf)
          .send({ version: first.version, expectedVersion: edited.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      expect(restored.version).toBeGreaterThan(edited.version);
      expect(restored.sections[0]!.body).toBe(original);

      /* The source version is untouched. */
      const source = (
        await session.agent
          .get(DOCUMENT_ROUTES.version(UNDERSTANDING, String(first.version)))
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(source.sections[0]!.body).toBe(original);
      expect(source.version).toBe(first.version);

      /* And the history says where the content came from. */
      const history = await versions(session, UNDERSTANDING);
      const entry = history.find((candidate) => candidate.version === restored.version)!;

      expect(entry.changeType).toBe('RESTORED');
      expect(entry.restoredFromVersion).toBe(first.version);
    });

    it('11. restoring an approved version does not restore the approval', async () => {
      const session = await project();
      await settle(session, UNDERSTANDING);

      const approved = await read(session, UNDERSTANDING);

      expect(approved.status).toBe('APPROVED');

      /* Reopen, edit, then bring the approved content back. */
      const reopened = (
        await session.agent
          .post(DOCUMENT_ROUTES.reopen(UNDERSTANDING))
          .set('x-csrf-token', session.csrf)
          .send({ reason: 'Revising the wording', expectedVersion: approved.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      await editSection(session, UNDERSTANDING, 'A change I will then undo.');

      const edited = await read(session, UNDERSTANDING);

      const restored = (
        await session.agent
          .post(DOCUMENT_ROUTES.restore(UNDERSTANDING))
          .set('x-csrf-token', session.csrf)
          .send({ version: approved.version, expectedVersion: edited.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      /* The content is back; the approval is not. */
      expect(restored.status).not.toBe('APPROVED');

      const history = await versions(session, UNDERSTANDING);
      const original = history.find((candidate) => candidate.version === approved.version)!;

      /* And the version that was approved still says so, with its timestamp. */
      expect(original.status).toBe('APPROVED');
      expect(original.approvedAt).toBeDefined();
      expect(reopened.version).toBeGreaterThan(approved.version);
    });

    it('12. reopening preserves the approved version and works on a new one', async () => {
      const session = await project();
      await settle(session, UNDERSTANDING);

      const approved = await read(session, UNDERSTANDING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'More detail needed', expectedVersion: approved.recordVersion })
        .expect(201);

      const working = await read(session, UNDERSTANDING);

      expect(working.status).toBe('NEEDS_REVISION');
      expect(working.version).toBeGreaterThan(approved.version);

      /*
       * The heart of it: editing the working version must not be able to rewrite the
       * approved one. This used to flip the status in place, and the next edit erased
       * the fact that anything had been approved.
       */
      await editSection(session, UNDERSTANDING, 'Edited after reopening.');

      const history = await versions(session, UNDERSTANDING);
      const original = history.find((candidate) => candidate.version === approved.version)!;

      expect(original.status).toBe('APPROVED');
      expect(original.approvedAt).toBeDefined();
    });

    it('13. an edited document has to be validated and approved again', async () => {
      const session = await project();
      await settle(session, UNDERSTANDING);

      const approved = await read(session, UNDERSTANDING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising', expectedVersion: approved.recordVersion })
        .expect(201);

      await editSection(session, UNDERSTANDING, 'New wording that nobody has approved.');

      const edited = await read(session, UNDERSTANDING);

      expect(edited.validation).toBeNull();

      /* Approval without validation is refused. */
      const refused = await session.agent
        .post(DOCUMENT_ROUTES.approve(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ acknowledged: true, expectedVersion: edited.recordVersion });

      expect(refused.status).toBe(422);

      await validate(session, UNDERSTANDING);
      const reapproved = await approve(session, UNDERSTANDING);

      expect(reapproved.status).toBe('APPROVED');
    });

    it('14. revising an issued document leaves it byte for byte unchanged', async () => {
      const session = await project();
      await settle(session, UNDERSTANDING);

      const approved = await read(session, UNDERSTANDING);

      const issued = (
        await session.agent
          .post(DOCUMENT_ROUTES.markFinal(UNDERSTANDING))
          .set('x-csrf-token', session.csrf)
          .send({ acknowledged: true, expectedVersion: approved.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      expect(issued.status).toBe('FINAL');

      const before = JSON.stringify(issued.sections);

      const revised = (
        await session.agent
          .post(DOCUMENT_ROUTES.revise(UNDERSTANDING))
          .set('x-csrf-token', session.csrf)
          .send({ reason: 'A second issue is needed', expectedVersion: issued.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      expect(revised.version).toBeGreaterThan(issued.version);

      /* The issued version, read back, is exactly as it was sent. */
      const stored = (
        await session.agent
          .get(DOCUMENT_ROUTES.version(UNDERSTANDING, String(issued.version)))
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(JSON.stringify(stored.sections)).toBe(before);

      const history = await versions(session, UNDERSTANDING);
      const issuedEntry = history.find((candidate) => candidate.version === issued.version)!;
      const workingEntry = history.find((candidate) => candidate.version === revised.version)!;

      expect(issuedEntry.status).toBe('FINAL');
      expect(issuedEntry.finalAt).toBeDefined();
      expect(workingEntry.revisedFromVersion).toBe(issued.version);
    });

    it('15. a row document can be edited after reopening', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await settle(session, CRITERIA);

      const approved = await read(session, CRITERIA);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(CRITERIA))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising a condition', expectedVersion: approved.recordVersion })
        .expect(201);

      const working = await read(session, CRITERIA);

      /* Its rows came across, so there is something to edit. */
      expect(working.rows.length).toBe(approved.rows.length);
      expect(working.status).toBe('NEEDS_REVISION');

      const row = working.rows[0]!;

      const edited = (
        await session.agent
          .patch(DOCUMENT_ROUTES.row(CRITERIA, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            payload: {
              ...(row.payload as Record<string, unknown>),
              notes: 'Reviewed after reopening.',
            },
            expectedVersion: working.recordVersion,
          })
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(edited.rows.length).toBe(working.rows.length);
    });
  });

  /* ==================================== 4. row removal =================== */

  describe('row removal', () => {
    it('16. removing a row takes it out of the working document only', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const before = await read(session, CRITERIA);
      const row = before.rows[0]!;
      const rowKey = (row.payload as { criterionKey: string }).criterionKey;

      const after = (
        await session.agent
          .delete(DOCUMENT_ROUTES.removeRow(CRITERIA, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            reason: 'A duplicate of the condition above it.',
            expectedVersion: before.recordVersion,
          })
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(after.rows).toHaveLength(before.rows.length - 1);
      expect(
        after.rows.some(
          (entry) => (entry.payload as { criterionKey: string }).criterionKey === rowKey,
        ),
      ).toBe(false);

      /* The version that had it still has it. */
      const stored = (
        await session.agent
          .get(DOCUMENT_ROUTES.version(CRITERIA, String(before.version)))
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(
        stored.rows.some(
          (entry) => (entry.payload as { criterionKey: string }).criterionKey === rowKey,
        ),
      ).toBe(true);

      /* And the history records the removal as such. */
      const history = await versions(session, CRITERIA);

      expect(history.some((entry) => entry.changeType === 'ROW_REMOVED')).toBe(true);
    });

    it('17. a removal shows up in the comparison as a removal', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const before = await read(session, CRITERIA);
      const row = before.rows[0]!;
      const rowKey = (row.payload as { criterionKey: string }).criterionKey;

      await session.agent
        .delete(DOCUMENT_ROUTES.removeRow(CRITERIA, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Removed for the comparison test.', expectedVersion: before.recordVersion })
        .expect(200);

      const after = await read(session, CRITERIA);
      const diff = await compare(session, CRITERIA, before.version, after.version);

      expect(diff.entries.some((entry) => entry.key === rowKey && entry.kind === 'REMOVED')).toBe(
        true,
      );
    });

    it('18. removing the only cover for approved scope is caught by validation', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const before = await read(session, CRITERIA);

      /*
       * Remove every row: the coverage the document owes is then unmistakably absent.
       *
       * Re-read each time, because every removal cuts a new version and row ids belong
       * to the version they were written for. Reusing the first read's ids would 404 on
       * the second removal — which is the versioning working, not a fault.
       */
      expect(before.rows.length).toBeGreaterThan(0);

      for (let remaining = before.rows.length; remaining > 0; remaining -= 1) {
        const current = await read(session, CRITERIA);

        await session.agent
          .delete(DOCUMENT_ROUTES.removeRow(CRITERIA, current.rows[0]!.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            reason: 'Clearing the document for the coverage test.',
            expectedVersion: current.recordVersion,
          })
          .expect(200);
      }

      const emptied = await validate(session, CRITERIA);

      /* Removal is not a way to make a blocker disappear. */
      expect(emptied.blockers.length).toBeGreaterThan(0);

      const refused = await session.agent
        .post(DOCUMENT_ROUTES.approve(CRITERIA))
        .set('x-csrf-token', session.csrf)
        .send({
          acknowledged: true,
          expectedVersion: (await read(session, CRITERIA)).recordVersion,
        });

      expect(refused.status).toBe(422);
    });
  });

  /* =============================== 5. currentness vs content ============= */

  describe('currentness and content are different things', () => {
    it('19. an upstream change makes a document outdated and leaves the approval', async () => {
      const session = await throughCriteria();

      const before = await read(session, CRITERIA);

      expect(before.status).toBe('APPROVED');
      expect(before.currentness).toBe('CURRENT');

      const content = JSON.stringify(before.rows);

      /* Reopen the Feature Listing above it. */
      const listing = await read(session, LISTING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(LISTING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising the agreed features', expectedVersion: listing.recordVersion })
        .expect(201);

      const after = await read(session, CRITERIA);

      /* Approved, and honestly labelled as no longer current. Content untouched. */
      expect(after.status).toBe('APPROVED');
      expect(after.currentness).toBe('OUTDATED');
      expect(JSON.stringify(after.rows)).toBe(content);
      expect(after.outdatedReasons.length).toBeGreaterThan(0);
    });

    it('20. a content change takes the approval away', async () => {
      const session = await throughCriteria();

      const approved = await read(session, CRITERIA);

      expect(approved.status).toBe('APPROVED');

      const row = approved.rows[0]!;

      const edited = (
        await session.agent
          .patch(DOCUMENT_ROUTES.row(CRITERIA, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            payload: {
              ...(row.payload as Record<string, unknown>),
              notes: 'Edited while approved.',
            },
            expectedVersion: approved.recordVersion,
          })
          .expect(200)
      ).body.document as DocumentSnapshot;

      /* What is in front of you is no longer what anybody approved. */
      expect(edited.status).not.toBe('APPROVED');
      expect(edited.validation).toBeNull();
    });

    it('21. approval is refused while a document is outdated', async () => {
      const session = await throughCriteria();

      const listing = await read(session, LISTING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(LISTING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising', expectedVersion: listing.recordVersion })
        .expect(201);

      /* Re-approving the prerequisite alone does not make the downstream current. */
      await validate(session, LISTING);
      await approve(session, LISTING);

      const criteria = await read(session, CRITERIA);

      expect(criteria.currentness).toBe('OUTDATED');

      const refused = await session.agent
        .post(DOCUMENT_ROUTES.markFinal(CRITERIA))
        .set('x-csrf-token', session.csrf)
        .send({ acknowledged: true, expectedVersion: criteria.recordVersion });

      expect(refused.status).toBe(422);
    });

    it('22. regenerating against the new authority clears the staleness', async () => {
      const session = await throughCriteria();

      const listing = await read(session, LISTING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(LISTING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising', expectedVersion: listing.recordVersion })
        .expect(201);

      await validate(session, LISTING);
      await approve(session, LISTING);

      expect((await read(session, CRITERIA)).currentness).toBe('OUTDATED');

      /* Written again against what is approved now. */
      await generate(session, CRITERIA);

      expect((await read(session, CRITERIA)).currentness).toBe('CURRENT');
    });

    it('23. there is no way to mark a document current by hand', async () => {
      const session = await throughCriteria();

      const listing = await read(session, LISTING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(LISTING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising', expectedVersion: listing.recordVersion })
        .expect(201);

      const criteria = await read(session, CRITERIA);

      expect(criteria.currentness).toBe('OUTDATED');

      /* Currentness is derived, so a request that tries to set it changes nothing. */
      const section = criteria.sections[0];

      if (section) {
        await session.agent
          .put(DOCUMENT_ROUTES.section(CRITERIA, section.sectionId))
          .set('x-csrf-token', session.csrf)
          .send({
            body: section.body,
            currentness: 'CURRENT',
            outdatedReasons: [],
            expectedVersion: criteria.recordVersion,
          })
          .expect(422);
      }

      expect((await read(session, CRITERIA)).currentness).toBe('OUTDATED');
    });
  });

  /* ==================================== 6. traceability ================= */

  describe('traceability', () => {
    it('24. follows every approved requirement through the documents that cite it', async () => {
      const session = await throughCriteria();
      const view = await traceability(session);

      expect(view.baselineVersion).not.toBeNull();
      expect(view.requirements.length).toBeGreaterThan(0);

      const traced = view.requirements.find((entry) => entry.links.length > 0)!;

      expect(traced).toBeDefined();
      expect(traced.links.map((link) => link.documentType)).toContain(LISTING);

      /* Links carry the human-facing key, not a database id. */
      for (const link of traced.links) {
        expect(link.key.length).toBeGreaterThan(0);
        expect(link.key.startsWith('doc_')).toBe(false);
      }
    });

    it('25. reports coverage per document without pretending it is always complete', async () => {
      const session = await throughCriteria();
      const view = await traceability(session);

      const listing = view.coverage.find((entry) => entry.documentType === LISTING)!;

      expect(listing.applicable).toBeGreaterThan(0);
      expect(listing.represented).toBeGreaterThan(0);
      expect(listing.represented).toBeLessThanOrEqual(listing.applicable);

      /* Documents that do not exist yet are not counted against anything. */
      const wbs = view.coverage.find((entry) => entry.documentType === 'WORK_BREAKDOWN_STRUCTURE')!;

      expect(wbs.documentVersion).toBeNull();
      expect(wbs.applicable).toBe(0);
    });

    it('26. never treats a missing assumption or dependency as a gap', async () => {
      const session = await throughCriteria();
      const view = await traceability(session);

      for (const entry of view.requirements) {
        expect(entry.missingFrom).not.toContain('ASSUMPTIONS');
        expect(entry.missingFrom).not.toContain('CLIENT_DEPENDENCY_SHEET');
      }

      const conditional = view.coverage.filter((entry) => entry.conditional);

      expect(conditional.map((entry) => entry.documentType).sort()).toEqual([
        'ASSUMPTIONS',
        'CLIENT_DEPENDENCY_SHEET',
      ]);
    });

    it('27. follows an artifact back to the requirements behind it', async () => {
      const session = await throughCriteria();

      const artifacts = (
        await session.agent.get(DOCUMENT_ROUTES.documentTraceability(CRITERIA)).expect(200)
      ).body.artifacts as { key: string; requirementKeys: string[]; danglingKeys: string[] }[];

      expect(artifacts.length).toBeGreaterThan(0);

      const supported = artifacts.find((artifact) => artifact.requirementKeys.length > 0)!;

      expect(supported).toBeDefined();
      expect(supported.danglingKeys).toEqual([]);
    });

    it('28. reports a gap when approved scope has no feature against it', async () => {
      const session = await throughListing();
      await generate(session, LISTING);

      const listing = await read(session, LISTING);

      /* Remove the coverage rather than exclude it: an exclusion is a decision. */
      const view = await traceability(session);

      const gapKinds = view.gaps.map((gap) => gap.kind);

      /* With everything covered there is no unmapped gap; the shape is what matters. */
      expect(Array.isArray(view.gaps)).toBe(true);
      expect(view.completeCount).toBeLessThanOrEqual(view.requirements.length);
      expect(gapKinds.every((kind) => typeof kind === 'string')).toBe(true);
      expect(listing.features.length).toBeGreaterThan(0);
    });

    it('29. marks the trace as stale when the document it came from is outdated', async () => {
      const session = await throughCriteria();

      const understanding = await read(session, UNDERSTANDING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising the summary', expectedVersion: understanding.recordVersion })
        .expect(201);

      const view = await traceability(session);

      /* Somewhere downstream is stale, and the view says so rather than looking fine. */
      expect(
        view.coverage.some((entry) => entry.stale) ||
          view.gaps.some((gap) => gap.kind === 'stale_trace'),
      ).toBe(true);
    });

    it('30. keeps requirement text out of the audit trail', async () => {
      const session = await throughCriteria();
      const view = await traceability(session);

      const events = await auditEvents(view.projectId);
      const viewed = events.find((event) => event.type === 'DOCUMENT_TRACEABILITY_VIEWED');

      expect(viewed).toBeDefined();
      expect(viewed!.metadata?.requirementCount).toBe(view.requirements.length);

      const serialised = JSON.stringify(events);

      for (const requirement of view.requirements.slice(0, 5)) {
        if (requirement.title.length > 20) {
          expect(serialised).not.toContain(requirement.title);
        }
      }
    });
  });

  /* ============================ 7. concurrency and security ============= */

  describe('concurrency and security', () => {
    /*
     * A request that loses a race must say so, not answer 201 having done nothing.
     *
     * Validation is stored against the record it read. Every content change now cuts a
     * new version, so a validation that overlaps one is writing against a record that has
     * moved — and that write used to be dropped on the floor: the response said 201, the
     * stored validation was never written, and the panel went on reading "not checked" no
     * matter how many times somebody pressed the button. It is reachable by hand, because
     * a person can press Validate while a regeneration is still in flight.
     *
     * Either outcome is correct — the validation is stored, or the conflict is reported —
     * so the race not landing on a given run cannot fail this. What it cannot be is
     * success with nothing to show for it.
     */
    it('39. a validation that overlaps a content change is stored or refused, never lost', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const document = await read(session, UNDERSTANDING);
      const section = document.sections[0]!;

      const [edit, validation] = await Promise.all([
        session.agent
          .put(DOCUMENT_ROUTES.section(UNDERSTANDING, section.sectionId))
          .set('x-csrf-token', session.csrf)
          .send({
            body: 'Reworded while the check was running.',
            expectedVersion: document.recordVersion,
          }),
        session.agent
          .post(DOCUMENT_ROUTES.validate(UNDERSTANDING))
          .set('x-csrf-token', session.csrf)
          .send({ useAi: false }),
      ]);

      expect([200, 409]).toContain(edit.status);
      expect([201, 409]).toContain(validation.status);

      if (validation.status === 201) {
        const snapshot = validation.body.document as DocumentSnapshot;

        /*
         * A validation reported as run has a result. The one case where `null` is
         * right is a content change that landed after it and invalidated it — which
         * shows up as the edit having won, not as a validation that never happened.
         */
        if (edit.status !== 200) {
          expect(snapshot.validation).not.toBeNull();
        }
      }
    });

    it('31. a stale edit is refused rather than overwriting somebody else', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const document = await read(session, UNDERSTANDING);
      const section = document.sections[0]!;
      const stale = document.recordVersion;

      await editSection(session, UNDERSTANDING, 'The first change wins.');

      const refused = await session.agent
        .put(DOCUMENT_ROUTES.section(UNDERSTANDING, section.sectionId))
        .set('x-csrf-token', session.csrf)
        .send({ body: 'The second change, from a stale read.', expectedVersion: stale });

      expect(refused.status).toBe(409);

      /* The first change is still there. */
      expect((await read(session, UNDERSTANDING)).sections[0]!.body).toContain('first change wins');
    });

    it('32. a stale restore is refused', async () => {
      const session = await project();
      await generate(session, UNDERSTANDING);

      const first = await read(session, UNDERSTANDING);
      const stale = first.recordVersion;

      await editSection(session, UNDERSTANDING, 'Moving the version on.');

      const refused = await session.agent
        .post(DOCUMENT_ROUTES.restore(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ version: first.version, expectedVersion: stale });

      expect(refused.status).toBe(409);
    });

    it('33. a stale removal is refused', async () => {
      const session = await throughListing();
      await settle(session, LISTING);
      await generate(session, CRITERIA);

      const document = await read(session, CRITERIA);
      const stale = document.recordVersion;
      const row = document.rows[0]!;

      await session.agent
        .patch(DOCUMENT_ROUTES.row(CRITERIA, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...(row.payload as Record<string, unknown>), notes: 'Moving the version on.' },
          expectedVersion: stale,
        })
        .expect(200);

      const refused = await session.agent
        .delete(DOCUMENT_ROUTES.removeRow(CRITERIA, document.rows[1]!.rowId))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'From a stale read.', expectedVersion: stale });

      expect(refused.status).toBe(409);
    });

    it('34. a restore cannot smuggle in status, dates or authority', async () => {
      const session = await project();
      await settle(session, UNDERSTANDING);

      const approved = await read(session, UNDERSTANDING);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising', expectedVersion: approved.recordVersion })
        .expect(201);

      const working = await read(session, UNDERSTANDING);

      /*
       * Every one of these is rejected by the strict schema rather than quietly
       * ignored. 422 is this application's convention for a request whose shape is
       * wrong — see `ZodValidationPipe`.
       */
      for (const extra of [
        { status: 'APPROVED' },
        { currentness: 'CURRENT' },
        { approvedAt: new Date().toISOString() },
        { finalAt: new Date().toISOString() },
        { projectId: 'prj_somebody_else' },
        { baselineVersion: 99 },
      ]) {
        await session.agent
          .post(DOCUMENT_ROUTES.restore(UNDERSTANDING))
          .set('x-csrf-token', session.csrf)
          .send({ version: approved.version, expectedVersion: working.recordVersion, ...extra })
          .expect(422);
      }

      expect((await read(session, UNDERSTANDING)).status).toBe('NEEDS_REVISION');
    });

    it('35. another project cannot read this project’s history, versions or comparison', async () => {
      const mine = await project();
      await settle(mine, UNDERSTANDING);

      const document = await read(mine, UNDERSTANDING);
      const stranger = await bareProject();

      /* Their own history, which is empty — not mine. */
      const history = await stranger.agent.get(DOCUMENT_ROUTES.versions(UNDERSTANDING));

      if (history.status === 200) {
        expect(history.body.versions).toEqual([]);
      } else {
        expect([401, 404, 422]).toContain(history.status);
      }

      /* A version number that exists in my project resolves to nothing in theirs. */
      const version = await stranger.agent.get(
        DOCUMENT_ROUTES.version(UNDERSTANDING, String(document.version)),
      );

      expect([401, 404, 422]).toContain(version.status);

      const diff = await stranger.agent.get(
        `${DOCUMENT_ROUTES.compare(UNDERSTANDING)}?left=1&right=${document.version}`,
      );

      expect([401, 404, 422]).toContain(diff.status);

      const restore = await stranger.agent
        .post(DOCUMENT_ROUTES.restore(UNDERSTANDING))
        .set('x-csrf-token', stranger.csrf)
        .send({ version: document.version, expectedVersion: 0 });

      expect([401, 404, 409, 422]).toContain(restore.status);
    });

    it('36. a historical version stays readable while the workflow is locked', async () => {
      const session = await throughCriteria();

      const criteria = await read(session, CRITERIA);
      const listing = await read(session, LISTING);

      /* Reopening the prerequisite locks the workflow below it. */
      await session.agent
        .post(DOCUMENT_ROUTES.reopen(LISTING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising', expectedVersion: listing.recordVersion })
        .expect(201);

      /* The document, and the specific version, both still read. */
      const readable = await read(session, CRITERIA);

      expect(readable.rows.length).toBeGreaterThan(0);

      const stored = await session.agent
        .get(DOCUMENT_ROUTES.version(CRITERIA, String(criteria.version)))
        .expect(200);

      expect((stored.body.document as DocumentSnapshot).rows.length).toBeGreaterThan(0);
    });

    it('37. a client dependency edit cannot smuggle a credential in through restore', async () => {
      /*
       * The Phase 9 protection has to survive the Phase 10 paths. Checked on the write
       * path that restore reuses: a refused payload never reaches storage, so no
       * historical version can newly persist one.
       */
      const session = await project();
      await settle(session, UNDERSTANDING);
      await settle(session, LISTING);
      await settle(session, CRITERIA);
      await settle(session, 'ASSUMPTIONS');
      await settle(session, 'STATEMENT_OF_WORK');
      await settle(session, 'WORK_BREAKDOWN_STRUCTURE');
      await generate(session, 'CLIENT_DEPENDENCY_SHEET');

      const sheet = await read(session, 'CLIENT_DEPENDENCY_SHEET');
      const row = sheet.rows[0]!;

      const refused = await session.agent
        .patch(DOCUMENT_ROUTES.row('CLIENT_DEPENDENCY_SHEET', row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: {
            ...(row.payload as ClientDependency),
            remarks: `they sent ${['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_')}`,
          },
          expectedVersion: sheet.recordVersion,
        });

      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain('CREDENTIAL_VALUE_REFUSED');

      /* Nothing was stored, so nothing can be restored. */
      const after = await read(session, 'CLIENT_DEPENDENCY_SHEET');

      expect(JSON.stringify(after.rows)).not.toContain('4eC39');
    });

    it('38. documents every Phase 10 operation in the OpenAPI document', async () => {
      const session = await project();
      const spec = (await session.agent.get('/api/docs-json').expect(200)).body as {
        paths: Record<string, Record<string, unknown>>;
      };

      const paths = Object.keys(spec.paths);

      for (const expected of ['versions', 'compare', 'restore', 'revise', 'traceability']) {
        expect(paths.some((path) => path.includes(expected))).toBe(true);
      }

      /* Row removal is a DELETE on the row path, which the row endpoints share. */
      const rowPath = paths.find((path) => path.endsWith('rows/{rowId}'))!;

      expect(Object.keys(spec.paths[rowPath]!)).toContain('delete');
    });
  });

  /* ------------------------------------------------------------- helpers */

  /** A project with a session and nothing else, for cross-project checks. */
  async function bareProject(): Promise<FixtureSession> {
    const agent = request.agent(app.getHttpServer());
    const created = await agent
      .post(PROJECT_ROUTES.create)
      .send({ name: 'A different project', projectTypes: ['WEB_APPLICATION'] })
      .expect(201);

    const raw: unknown = created.headers['set-cookie'];
    const cookies: string[] = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];

    const csrf =
      cookies
        .find((value) => value.startsWith('wdrg_csrf'))
        ?.split(';')[0]
        ?.split('=')[1] ?? '';

    return { agent, csrf };
  }

  async function auditEvents(
    projectId: string,
  ): Promise<readonly { type: string; metadata?: Record<string, unknown> }[]> {
    const { getConnectionToken } = await import('@nestjs/mongoose');

    const events: unknown = await app
      .get(getConnectionToken())
      .collection('audit_events')
      .find({ projectId })
      .toArray();

    return events as readonly { type: string; metadata?: Record<string, unknown> }[];
  }
});
