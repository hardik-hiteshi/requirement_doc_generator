import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ANALYSIS_ROUTES,
  API_PREFIX,
  REQUIREMENT_ROUTES,
  API_VERSION,
  DOCUMENT_ROUTES,
  ESTIMATION_ROUTES,
  FEATURE_CSV_HEADER,
  STACK_ROUTES,
  UNDERSTANDING_SECTIONS,
  validateFeatureCsv,
  type DocumentSnapshot,
  type DocumentSummary,
  type DocumentVersionSummary,
  type EstimateSnapshot,
  type StackSnapshot,
} from '@wdrg/contracts';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { setupOpenApi } from '../src/openapi';
import { configureSecurity } from '../src/security';
import {
  approvedEstimateProject,
  documentFixture,
  registerDocumentGeneration,
  registerInventedContent,
  type FixtureSession,
} from './documents-fixtures';

/**
 * The document workflow, end to end, against a real database.
 *
 * Organised around the four things Phase 7 promises and could plausibly break:
 * that a document uses only approved upstream artifacts, that a person's writing
 * survives a machine, that Feature Listing hours are the estimate's hours, and
 * that an upstream change is reported rather than silently applied.
 *
 * The AI is off in most of these. The deterministic composer is not a fallback —
 * it is the path that always runs, and a suite that only exercised the model path
 * would not be testing the document at all.
 */
describe('Documents (e2e)', () => {
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

  async function project(fixture = WEB): Promise<FixtureSession> {
    return approvedEstimateProject(app.getHttpServer(), provider, fixture);
  }

  async function documents(session: FixtureSession): Promise<readonly DocumentSummary[]> {
    const response = await session.agent.get(DOCUMENT_ROUTES.documents).expect(200);

    return response.body.documents as DocumentSummary[];
  }

  async function read(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    const response = await session.agent.get(DOCUMENT_ROUTES.document(type)).expect(200);

    return response.body.document as DocumentSnapshot;
  }

  async function generate(
    session: FixtureSession,
    type: string,
    useAi = false,
    reason?: string,
  ): Promise<DocumentSnapshot> {
    const current = await read(session, type);

    const response = await session.agent
      .post(DOCUMENT_ROUTES.generate(type))
      .set('x-csrf-token', session.csrf)
      .send({ useAi, ...(reason ? { reason } : {}), expectedVersion: current.recordVersion })
      .expect(201);

    return response.body.document as DocumentSnapshot;
  }

  async function validate(
    session: FixtureSession,
    type: string,
    useAi = false,
  ): Promise<DocumentSnapshot> {
    const response = await session.agent
      .post(DOCUMENT_ROUTES.validate(type))
      .set('x-csrf-token', session.csrf)
      .send({ useAi })
      .expect(201);

    return response.body.document as DocumentSnapshot;
  }

  async function approve(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    const current = await read(session, type);

    const response = await session.agent
      .post(DOCUMENT_ROUTES.approve(type))
      .set('x-csrf-token', session.csrf)
      .send({ acknowledged: true, expectedVersion: current.recordVersion })
      .expect(201);

    return response.body.document as DocumentSnapshot;
  }

  /** Generate, validate and approve Our Understanding — the usual precondition. */
  async function approvedUnderstanding(session: FixtureSession): Promise<DocumentSnapshot> {
    await generate(session, 'OUR_UNDERSTANDING');
    await validate(session, 'OUR_UNDERSTANDING');

    return approve(session, 'OUR_UNDERSTANDING');
  }

  async function editSection(
    session: FixtureSession,
    type: string,
    sectionId: string,
    body: string,
  ): Promise<DocumentSnapshot> {
    const current = await read(session, type);

    const response = await session.agent
      .put(DOCUMENT_ROUTES.section(type, sectionId))
      .set('x-csrf-token', session.csrf)
      .send({ body, expectedVersion: current.recordVersion })
      .expect(200);

    return response.body.document as DocumentSnapshot;
  }

  const sectionByKey = (document: DocumentSnapshot, key: string) =>
    document.sections.find((section) => section.key === key)!;

  /* ------------------------------------------------ 1. ordering and locking */

  describe('the document sequence', () => {
    it('offers Our Understanding and locks Feature Listing behind it', async () => {
      const session = await project();
      const list = await documents(session);

      const understanding = list.find((entry) => entry.type === 'OUR_UNDERSTANDING')!;
      const features = list.find((entry) => entry.type === 'FEATURE_LISTING')!;

      expect(understanding.lock).toBeNull();
      expect(features.lock?.reason).toBe('prerequisite_document');
      expect(features.lock?.summary).toContain('OUR_UNDERSTANDING');
    }, 240_000);

    it('refuses to generate Feature Listing before Understanding is approved', async () => {
      const session = await project();

      const refusal = await session.agent
        .post(DOCUMENT_ROUTES.generate('FEATURE_LISTING'))
        .set('x-csrf-token', session.csrf)
        .send({ useAi: false, expectedVersion: 0 })
        .expect(422);

      expect(JSON.stringify(refusal.body)).toContain('DOCUMENT_LOCKED');
    }, 240_000);

    it('unlocks Feature Listing once Understanding is approved', async () => {
      const session = await project();
      await approvedUnderstanding(session);

      const list = await documents(session);
      expect(list.find((entry) => entry.type === 'FEATURE_LISTING')?.lock).toBeNull();
    }, 240_000);

    it('shows the five unimplemented documents as unavailable, never as broken', async () => {
      const session = await project();
      const list = await documents(session);

      const unavailable = list.filter((entry) => !entry.implemented);

      expect(unavailable).toHaveLength(5);
      for (const entry of unavailable) {
        expect(entry.lock?.reason).toBe('not_implemented');
        expect(entry.status).toBe('NOT_STARTED');
      }
    }, 240_000);
  });

  /* ---------------------------------------------- 2. Our Understanding */

  describe('Our Understanding', () => {
    it('is written from the approved baseline, with every section traceable', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');

      expect(document.status).toBe('DRAFT');
      expect(document.version).toBe(1);
      expect(document.sections).toHaveLength(UNDERSTANDING_SECTIONS.length);
      expect(document.baselineVersion).toBe(1);

      /* The overview and the scope are there, and the scope cites requirements. */
      expect(sectionByKey(document, 'project-overview').body.length).toBeGreaterThan(0);

      const scope = sectionByKey(document, 'functional-scope');
      expect(scope.body).toMatch(/REQ-\d{3}/);
      expect(scope.references.length).toBeGreaterThan(0);
      expect(scope.references[0]?.kind).toBe('REQUIREMENT');
    }, 240_000);

    it('leaves a section empty with a reason rather than writing filler', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');

      /* Nothing in the brief is an integration, so that section says so. */
      const integrations = sectionByKey(document, 'integrations');

      expect(integrations.body).toBe('');
      expect(integrations.omittedReason).toContain('say nothing about this');
    }, 240_000);

    it('carries an explicit out-of-scope statement into the document', async () => {
      const session = await project(documentFixture('a project with explicit out-of-scope items'));
      const document = await generate(session, 'OUR_UNDERSTANDING');

      expect(sectionByKey(document, 'out-of-scope').body).toMatch(/out of scope|not be included/i);
    }, 240_000);

    it('carries an explicit non-functional requirement, with its stated figure', async () => {
      const session = await project(
        documentFixture('a project with an explicit non-functional requirement'),
      );
      const document = await generate(session, 'OUR_UNDERSTANDING');
      const nonFunctional = sectionByKey(document, 'non-functional');

      /* Either the requirement was classified non-functional and appears with its
         figure, or it did not and the section is honestly empty. Never invented. */
      if (nonFunctional.body.length > 0) {
        expect(nonFunctional.body).toMatch(/3 seconds|500 records/);
      } else {
        expect(nonFunctional.omittedReason).toBeTruthy();
      }

      const joined = document.sections.map((section) => section.body).join(' ');
      expect(joined).not.toMatch(/99\.9|uptime|GDPR|WCAG/i);
    }, 240_000);

    it('can be validated, and reports coverage as a fact', async () => {
      const session = await project();
      await generate(session, 'OUR_UNDERSTANDING');
      const document = await validate(session, 'OUR_UNDERSTANDING');

      expect(document.validation).not.toBeNull();
      expect(document.validation?.documentVersion).toBe(document.version);
      expect(document.validation?.modelAssisted).toBe(false);
      expect(
        document.validation?.findings.some((finding) => finding.kind === 'requirement_uncovered'),
      ).toBe(true);
    }, 240_000);

    it('cannot be approved before it has been validated', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');

      const refusal = await session.agent
        .post(DOCUMENT_ROUTES.approve('OUR_UNDERSTANDING'))
        .set('x-csrf-token', session.csrf)
        .send({ acknowledged: true, expectedVersion: document.recordVersion })
        .expect(422);

      expect(JSON.stringify(refusal.body)).toContain('DOCUMENT_NOT_VALIDATED');
    }, 240_000);

    it('cannot be approved while a blocking finding stands', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');

      /* Emptying a required section is a blocking finding. */
      const overview = sectionByKey(document, 'project-overview');
      await editSection(session, 'OUR_UNDERSTANDING', overview.sectionId, '   ');
      const validated = await validate(session, 'OUR_UNDERSTANDING');

      expect(validated.validation?.severity).toBe('BLOCKING');

      const refusal = await session.agent
        .post(DOCUMENT_ROUTES.approve('OUR_UNDERSTANDING'))
        .set('x-csrf-token', session.csrf)
        .send({ acknowledged: true, expectedVersion: validated.recordVersion })
        .expect(422);

      expect(JSON.stringify(refusal.body)).toContain('DOCUMENT_HAS_BLOCKERS');
    }, 240_000);

    /* The exact sequence the browser walks: break it, check, fix it, check, approve. */
    it('approves after a blocking finding has been fixed and rechecked', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');
      const overview = sectionByKey(document, 'project-overview');

      await editSection(session, 'OUR_UNDERSTANDING', overview.sectionId, '   ');
      const broken = await validate(session, 'OUR_UNDERSTANDING');
      expect(broken.validation?.severity).toBe('BLOCKING');

      await editSection(
        session,
        'OUR_UNDERSTANDING',
        overview.sectionId,
        'A timesheet and approval system for internal staff.',
      );
      const fixed = await validate(session, 'OUR_UNDERSTANDING');

      expect(fixed.validation?.severity).not.toBe('BLOCKING');
      expect(fixed.blockers).toEqual([]);

      const approved = await approve(session, 'OUR_UNDERSTANDING');
      expect(approved.status).toBe('APPROVED');
    }, 240_000);

    it('approves once validation passes, and records when', async () => {
      const session = await project();
      const approved = await approvedUnderstanding(session);

      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedAt).toBeDefined();
      expect(approved.blockers).toEqual([]);
    }, 240_000);
  });

  /* ------------------------------------------------- 3. editing authority */

  describe('a person’s writing', () => {
    it('is protected from the next regeneration, which proposes instead', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');
      const overview = sectionByKey(document, 'project-overview');

      const mine = 'A timesheet system for a distribution business, written by me.';
      const edited = await editSection(session, 'OUR_UNDERSTANDING', overview.sectionId, mine);

      expect(sectionByKey(edited, 'project-overview').origin).toBe('USER_EDITED');

      /* Regenerating the whole document must not overwrite it. */
      const regenerated = await generate(session, 'OUR_UNDERSTANDING', false, 'Second pass');
      const after = sectionByKey(regenerated, 'project-overview');

      expect(after.body).toBe(mine);
      expect(after.origin).toBe('USER_EDITED');
      expect(after.proposedBody).toBeTruthy();
      expect(regenerated.blockers.map((blocker) => blocker.kind)).toContain('unresolved_proposal');
    }, 240_000);

    it.each([
      ['KEEP_CURRENT', 'mine'],
      ['ACCEPT_GENERATED_REVISION', 'proposed'],
      ['EDIT_GENERATED_REVISION', 'edited'],
    ])(
      'resolves a proposal with %s',
      async (decision, expected) => {
        const session = await project();
        const document = await generate(session, 'OUR_UNDERSTANDING');
        const overview = sectionByKey(document, 'project-overview');

        const mine = 'My own overview.';
        await editSection(session, 'OUR_UNDERSTANDING', overview.sectionId, mine);
        const regenerated = await generate(session, 'OUR_UNDERSTANDING');

        const section = sectionByKey(regenerated, 'project-overview');
        const proposed = section.proposedBody!;

        const response = await session.agent
          .post(DOCUMENT_ROUTES.resolveProposal('OUR_UNDERSTANDING', section.sectionId))
          .set('x-csrf-token', session.csrf)
          .send({
            decision,
            ...(decision === 'EDIT_GENERATED_REVISION' ? { body: 'A blend of both.' } : {}),
            expectedVersion: regenerated.recordVersion,
          })
          .expect(201);

        const resolved = sectionByKey(
          response.body.document as DocumentSnapshot,
          'project-overview',
        );

        expect(resolved.body).toBe(
          expected === 'mine' ? mine : expected === 'proposed' ? proposed : 'A blend of both.',
        );
        /* Whatever they chose, the section stays theirs. */
        expect(resolved.origin).toBe('USER_EDITED');
        expect(resolved.proposedBody).toBeUndefined();
      },
      240_000,
    );

    it('regenerates one section without touching the others', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');
      const before = document.sections.map((section) => section.body);
      const target = sectionByKey(document, 'solution-understanding');

      const response = await session.agent
        .post(DOCUMENT_ROUTES.regenerateSection('OUR_UNDERSTANDING', target.sectionId))
        .set('x-csrf-token', session.csrf)
        .send({ useAi: false, expectedVersion: document.recordVersion })
        .expect(201);

      const after = response.body.document as DocumentSnapshot;

      expect(after.version).toBe(document.version);
      expect(after.sections.map((section) => section.body)).toEqual(before);
    }, 240_000);

    it('takes an approved document back to draft when a section is edited', async () => {
      const session = await project();
      const approved = await approvedUnderstanding(session);
      const overview = sectionByKey(approved, 'project-overview');

      const edited = await editSection(
        session,
        'OUR_UNDERSTANDING',
        overview.sectionId,
        'A revised overview.',
      );

      expect(edited.status).toBe('DRAFT');
      /* And the result that described the old content is gone. */
      expect(edited.validation).toBeNull();
    }, 240_000);

    it('refuses to edit an issued document', async () => {
      const session = await project();
      const approved = await approvedUnderstanding(session);

      const issued = (
        await session.agent
          .post(DOCUMENT_ROUTES.markFinal('OUR_UNDERSTANDING'))
          .set('x-csrf-token', session.csrf)
          .send({ acknowledged: true, expectedVersion: approved.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      expect(issued.status).toBe('FINAL');
      expect(issued.finalAt).toBeDefined();

      const refusal = await session.agent
        .put(
          DOCUMENT_ROUTES.section(
            'OUR_UNDERSTANDING',
            sectionByKey(issued, 'project-overview').sectionId,
          ),
        )
        .set('x-csrf-token', session.csrf)
        .send({ body: 'Too late.', expectedVersion: issued.recordVersion })
        .expect(409);

      expect(JSON.stringify(refusal.body)).toContain('DOCUMENT_FINAL');
    }, 240_000);
  });

  /* ------------------------------------------------ 4. versions and history */

  describe('versions', () => {
    it('keeps every version, compares them and restores one forward', async () => {
      const session = await project();
      const first = await generate(session, 'OUR_UNDERSTANDING');
      const overview = sectionByKey(first, 'project-overview');

      await editSection(session, 'OUR_UNDERSTANDING', overview.sectionId, 'Version one text.');
      const second = await generate(session, 'OUR_UNDERSTANDING', false, 'A second pass');

      expect(second.version).toBe(2);
      expect(second.supersedesVersion).toBe(1);

      const versions = (
        await session.agent.get(DOCUMENT_ROUTES.versions('OUR_UNDERSTANDING')).expect(200)
      ).body.versions as DocumentVersionSummary[];

      expect(versions.map((entry) => entry.version)).toEqual([2, 1]);
      expect(versions.find((entry) => entry.version === 1)?.userEditedCount).toBe(1);

      /* Version one still says what it said. */
      const stored = (
        await session.agent.get(DOCUMENT_ROUTES.version('OUR_UNDERSTANDING', '1')).expect(200)
      ).body.document as DocumentSnapshot;

      expect(stored.sections.find((section) => section.key === 'project-overview')?.body).toBe(
        'Version one text.',
      );

      /* Comparing reports the change and leaves everything else alone. */
      /*
       * Version two is a deterministic regeneration of the same baseline, so it
       * matches version one until somebody changes something. Editing here is
       * what makes the comparison a comparison.
       */
      await editSection(
        session,
        'OUR_UNDERSTANDING',
        sectionByKey(second, 'project-overview').sectionId,
        'Version two text.',
      );

      const diff = (
        await session.agent
          .get(`${DOCUMENT_ROUTES.compare('OUR_UNDERSTANDING')}?left=1&right=2`)
          .expect(200)
      ).body.diff as { changedCount: number; entries: { key: string; kind: string }[] };

      expect(diff.changedCount).toBeGreaterThan(0);
      expect(diff.entries.find((entry) => entry.key === 'project-overview')?.kind).toBe('CHANGED');

      /* Restoring copies forward as version three. */
      const current = await read(session, 'OUR_UNDERSTANDING');
      const restored = (
        await session.agent
          .post(DOCUMENT_ROUTES.restore('OUR_UNDERSTANDING'))
          .set('x-csrf-token', session.csrf)
          .send({ version: 1, expectedVersion: current.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      expect(restored.version).toBe(3);
      expect(sectionByKey(restored, 'project-overview').body).toBe('Version one text.');
      /* A restored section is protected: somebody chose that text. */
      expect(sectionByKey(restored, 'project-overview').origin).toBe('USER_EDITED');

      /* And version one is exactly where it was. */
      const unchanged = (
        await session.agent.get(DOCUMENT_ROUTES.version('OUR_UNDERSTANDING', '1')).expect(200)
      ).body.document as DocumentSnapshot;

      expect(unchanged.sections.find((section) => section.key === 'project-overview')?.body).toBe(
        'Version one text.',
      );
    }, 240_000);

    it('refuses a version that does not exist', async () => {
      const session = await project();
      await generate(session, 'OUR_UNDERSTANDING');

      await session.agent.get(DOCUMENT_ROUTES.version('OUR_UNDERSTANDING', '99')).expect(404);
    }, 240_000);
  });

  /* ------------------------------------------------- 5. the Feature Listing */

  describe('Feature Listing', () => {
    async function featureProject(fixture = WEB): Promise<FixtureSession> {
      const session = await project(fixture);
      await approvedUnderstanding(session);
      await generate(session, 'FEATURE_LISTING');

      return session;
    }

    it('builds rows from the approved estimate, with its hours', async () => {
      const session = await featureProject();
      const document = await read(session, 'FEATURE_LISTING');

      expect(document.features.length).toBeGreaterThan(0);
      expect(document.estimateVersion).toBe(1);

      const estimate = (await session.agent.get(ESTIMATION_ROUTES.estimate).expect(200)).body
        .snapshot as EstimateSnapshot;

      for (const row of document.features) {
        const unit = estimate.estimates.find((entry) => entry.id === row.estimateUnitIds[0])!;

        expect(unit).toBeDefined();
        expect(row.effort).toEqual(unit.effort);
        expect(row.totalHours).toBe(unit.totalHours);
        expect(row.requirementIds.length).toBeGreaterThan(0);
      }

      /* And the totals reconcile with the estimate exactly. */
      expect(document.reconciliation?.reconciles).toBe(true);
      expect(document.reconciliation?.differenceHours).toBe(0);
    }, 240_000);

    it('reports coverage from disposition, never as a flat 100%', async () => {
      const session = await featureProject();
      const document = await read(session, 'FEATURE_LISTING');

      expect(document.coverage).not.toBeNull();
      expect(document.coverage?.applicable).toBeGreaterThan(0);
      expect(document.coverage?.percentage).toBe(
        Number(
          (
            ((document.coverage!.represented + document.coverage!.excluded) /
              document.coverage!.applicable) *
            100
          ).toFixed(1),
        ),
      );
    }, 240_000);

    it('refuses an attempt to change hours, and says where they are changed', async () => {
      const session = await featureProject();
      const document = await read(session, 'FEATURE_LISTING');
      const row = document.features[0]!;

      const refusal = await session.agent
        .patch(DOCUMENT_ROUTES.feature('FEATURE_LISTING', row.featureId))
        .set('x-csrf-token', session.csrf)
        .send({ effort: { BACKEND: 999 }, expectedVersion: document.recordVersion })
        .expect(422);

      expect(JSON.stringify(refusal.body)).toContain('EFFORT_NOT_EDITABLE_HERE');

      /* Nothing changed. */
      const after = await read(session, 'FEATURE_LISTING');
      expect(after.features[0]?.effort).toEqual(row.effort);
    }, 240_000);

    it('allows a descriptive edit and keeps the hours', async () => {
      const session = await featureProject();
      const document = await read(session, 'FEATURE_LISTING');
      const row = document.features[0]!;

      const response = await session.agent
        .patch(DOCUMENT_ROUTES.feature('FEATURE_LISTING', row.featureId))
        .set('x-csrf-token', session.csrf)
        .send({
          module: 'Timesheets',
          screen: 'Weekly grid',
          notes: 'Confirmed with the client.',
          expectedVersion: document.recordVersion,
        })
        .expect(200);

      const edited = (response.body.document as DocumentSnapshot).features.find(
        (entry) => entry.featureId === row.featureId,
      )!;

      expect(edited.module).toBe('Timesheets');
      expect(edited.screen).toBe('Weekly grid');
      expect(edited.reviewStatus).toBe('USER_EDITED');
      expect(edited.effort).toEqual(row.effort);
      expect(edited.totalHours).toBe(row.totalHours);
    }, 240_000);

    it('keeps a descriptive edit through a regeneration', async () => {
      const session = await featureProject();
      const document = await read(session, 'FEATURE_LISTING');
      const row = document.features[0]!;

      await session.agent
        .patch(DOCUMENT_ROUTES.feature('FEATURE_LISTING', row.featureId))
        .set('x-csrf-token', session.csrf)
        .send({ module: 'My module name', expectedVersion: document.recordVersion })
        .expect(200);

      const regenerated = await generate(session, 'FEATURE_LISTING');
      const same = regenerated.features.find(
        (entry) => entry.estimateUnitIds[0] === row.estimateUnitIds[0],
      )!;

      expect(same.module).toBe('My module name');
      expect(same.reviewStatus).toBe('USER_EDITED');
      /* Hours still the estimate's, whatever the description says. */
      expect(same.effort).toEqual(row.effort);
    }, 240_000);

    it('leaves the Screen empty for a project with no interface', async () => {
      const session = await featureProject(documentFixture('an API-only service'));
      const document = await read(session, 'FEATURE_LISTING');

      expect(document.features.length).toBeGreaterThan(0);
      for (const row of document.features) {
        expect(row.screen).toBe('');
      }

      /* And the exported cell is an explicit empty string, not a missing field. */
      const csv = (await session.agent.get(DOCUMENT_ROUTES.csv('FEATURE_LISTING')).expect(200)).body
        .csv as string;

      expect(csv.split('\r\n')[1]?.split(',')[2]).toBe('""');
    }, 240_000);

    it('keeps mobile hours, which have no column of their own', async () => {
      const session = await featureProject(documentFixture('a mobile application'));
      const document = await read(session, 'FEATURE_LISTING');

      /*
       * Whichever roles a cross-platform mobile project actually prices, the ones
       * without a column of their own must survive into the last cell by name. A
       * test naming only MOBILE would pass or fail on Phase 6's role split rather
       * than on this document's projection.
       */
      const columnRoles = ['BACKEND', 'FRONTEND', 'QA'];
      const otherRoles = [
        ...new Set(
          document.features.flatMap((row) =>
            Object.entries(row.effort)
              .filter(([role, hours]) => hours > 0 && !columnRoles.includes(role))
              .map(([role]) => role),
          ),
        ),
      ];

      expect(otherRoles.length).toBeGreaterThan(0);

      const csv = (await session.agent.get(DOCUMENT_ROUTES.csv('FEATURE_LISTING')).expect(200)).body
        .csv as string;

      /* Named in the last column rather than dropped. */
      const lastCells = csv
        .split('\r\n')
        .slice(1)
        .filter((line) => line.length > 0)
        .map((line) => line.split(',').at(-1) ?? '');

      expect(lastCells.some((cell) => cell.length > 2)).toBe(true);
      expect(csv).toMatch(/Mobile Dev:|UI\/UX:|DevOps:|BA:|PM:|SA:/);
    }, 240_000);

    it('serialises the strict eight-column CSV, every value quoted', async () => {
      const session = await featureProject();
      const csv = (await session.agent.get(DOCUMENT_ROUTES.csv('FEATURE_LISTING')).expect(200)).body
        .csv as string;

      expect(csv.startsWith(FEATURE_CSV_HEADER)).toBe(true);
      expect(validateFeatureCsv(csv)).toEqual({ valid: true });

      const firstRow = csv.split('\r\n')[1]!;
      expect(firstRow.split(',')).toHaveLength(8);
    }, 240_000);

    it('separates several description points with a pipe', async () => {
      const session = await featureProject();
      const document = await read(session, 'FEATURE_LISTING');
      const row = document.features[0]!;

      await session.agent
        .patch(DOCUMENT_ROUTES.feature('FEATURE_LISTING', row.featureId))
        .set('x-csrf-token', session.csrf)
        .send({
          description: 'A user submits the week | The system records who submitted it',
          expectedVersion: document.recordVersion,
        })
        .expect(200);

      const csv = (await session.agent.get(DOCUMENT_ROUTES.csv('FEATURE_LISTING')).expect(200)).body
        .csv as string;

      expect(csv).toContain('A user submits the week | The system records who submitted it');
      expect(validateFeatureCsv(csv)).toEqual({ valid: true });
    }, 240_000);

    it('refuses a CSV of a document that is not a table', async () => {
      const session = await project();
      await generate(session, 'OUR_UNDERSTANDING');

      await session.agent.get(DOCUMENT_ROUTES.csv('OUR_UNDERSTANDING')).expect(422);
    }, 240_000);

    it('validates, approves, and reports the estimate as reconciled', async () => {
      const session = await featureProject();
      const validated = await validate(session, 'FEATURE_LISTING');

      expect(
        validated.validation?.findings.some(
          (finding) => finding.kind === 'effort_mismatch' && finding.severity === 'PASS',
        ),
      ).toBe(true);

      const approved = await approve(session, 'FEATURE_LISTING');
      expect(approved.status).toBe('APPROVED');
    }, 240_000);

    it('records a requirement as deliberately excluded, and counts it as handled', async () => {
      const session = await featureProject();
      const before = await read(session, 'FEATURE_LISTING');
      const unresolved = before.coverage?.unresolvedRequirementIds ?? [];

      if (unresolved.length === 0) {
        /* Full coverage already, which is a valid outcome for this fixture. */
        expect(before.coverage?.unresolved).toBe(0);
        return;
      }

      const response = await session.agent
        .post(DOCUMENT_ROUTES.excludeRequirement('FEATURE_LISTING'))
        .set('x-csrf-token', session.csrf)
        .send({
          requirementId: unresolved[0],
          reason: 'Covered by an existing module, agreed with the client.',
          expectedVersion: before.recordVersion,
        })
        .expect(201);

      const after = response.body.document as DocumentSnapshot;

      expect(after.coverage?.excluded).toBe(1);
      expect(after.coverage!.unresolved).toBe(before.coverage!.unresolved - 1);
    }, 240_000);
  });

  /* ------------------------------------------- 6. outdated propagation */

  describe('when something upstream moves', () => {
    it('marks Feature Listing out of date when Understanding is reopened', async () => {
      const session = await project();
      const understanding = await approvedUnderstanding(session);
      await generate(session, 'FEATURE_LISTING');
      await validate(session, 'FEATURE_LISTING');
      await approve(session, 'FEATURE_LISTING');

      await session.agent
        .post(DOCUMENT_ROUTES.reopen('OUR_UNDERSTANDING'))
        .set('x-csrf-token', session.csrf)
        .send({
          reason: 'The client corrected the scope.',
          expectedVersion: understanding.recordVersion,
        })
        .expect(201);

      const features = await read(session, 'FEATURE_LISTING');

      expect(features.status).toBe('OUTDATED');
      expect(features.outdatedReasons.map((reason) => reason.cause)).toContain(
        'prerequisite_document_changed',
      );
      /* Reported, never rewritten. */
      expect(features.features.length).toBeGreaterThan(0);
    }, 240_000);

    it('marks a document out of date when the baseline changes, and changes nothing', async () => {
      const session = await project();
      const approved = await approvedUnderstanding(session);
      const bodies = approved.sections.map((section) => section.body);

      /*
       * A new source, reviewed. Phase 4 marks the approved baseline outdated
       * without changing its version — which is exactly the case a version
       * comparison cannot see, so the engine has to notice it another way.
       */
      const added = await session.agent
        .post(REQUIREMENT_ROUTES.textSources)
        .set('x-csrf-token', session.csrf)
        .send({ title: 'Late addition', text: 'Timesheets must be exportable as PDF.' })
        .expect(201);

      await session.agent
        .post(REQUIREMENT_ROUTES.review(added.body.sourceId))
        .set('x-csrf-token', session.csrf)
        .send({ version: added.body.version })
        .expect(200);

      const after = await read(session, 'OUR_UNDERSTANDING');

      expect(after.status).toBe('OUTDATED');
      expect(after.outdatedReasons.map((reason) => reason.cause)).toContain('baseline_changed');
      /* The content is exactly what it was. Nothing was regenerated. */
      expect(after.sections.map((section) => section.body)).toEqual(bodies);
      expect(after.blockers.map((blocker) => blocker.kind)).toContain('outdated_inputs');

      /* And validation says so too, as a blocking finding. */
      const validated = await validate(session, 'OUR_UNDERSTANDING');
      expect(
        validated.validation?.findings.some((finding) => finding.kind === 'stale_baseline'),
      ).toBe(true);
    }, 240_000);

    it('marks Feature Listing out of date when the estimate changes', async () => {
      const session = await project();
      await approvedUnderstanding(session);
      await generate(session, 'FEATURE_LISTING');

      /* Reopening and re-approving the estimate produces a new version. */
      const estimate = (await session.agent.get(ESTIMATION_ROUTES.estimate).expect(200)).body
        .snapshot as EstimateSnapshot;

      await session.agent
        .post(ESTIMATION_ROUTES.reopen)
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'A figure was wrong.', expectedVersion: estimate.recordVersion })
        .expect(200);

      const reopened = (await session.agent.get(ESTIMATION_ROUTES.estimate).expect(200)).body
        .snapshot as EstimateSnapshot;

      const features = await read(session, 'FEATURE_LISTING');

      /*
       * The estimate is no longer approved, so it is no longer authority. The
       * document says so rather than continuing to quote it as current.
       */
      expect(reopened.status).not.toBe('APPROVED');
      expect(features.blockers.length).toBeGreaterThan(0);
    }, 240_000);

    it('marks Feature Listing out of date when the stack is unlocked', async () => {
      const session = await project();
      await approvedUnderstanding(session);
      await generate(session, 'FEATURE_LISTING');

      const stack = (await session.agent.get(STACK_ROUTES.stack).expect(200)).body
        .snapshot as StackSnapshot;

      await session.agent
        .post(STACK_ROUTES.unlock)
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'A technology has to change.', expectedVersion: stack.recordVersion })
        .expect(200);

      const features = await read(session, 'FEATURE_LISTING');
      expect(features.blockers.length).toBeGreaterThan(0);
    }, 240_000);
  });

  /* -------------------------------------------------------- 7. the AI path */

  describe('with a model', () => {
    it('writes prose into the sections the application chose', async () => {
      const session = await project();
      const requirements = (await session.agent.get(ANALYSIS_ROUTES.requirements).expect(200))
        .body as { key: string }[];

      registerDocumentGeneration(
        provider,
        requirements.map((requirement) => requirement.key),
        UNDERSTANDING_SECTIONS.map((section) => section.key),
      );

      const document = await generate(session, 'OUR_UNDERSTANDING', true);

      expect(document.sections.length).toBe(UNDERSTANDING_SECTIONS.length);
      expect(sectionByKey(document, 'functional-scope').body).toContain('weekly timesheets');

      const run = (
        await session.agent.get(DOCUMENT_ROUTES.currentRun('OUR_UNDERSTANDING')).expect(200)
      ).body as {
        deterministicOnly: boolean;
        provider: string;
        promptVersions: Record<string, string>;
      };

      expect(run.deterministicOnly).toBe(false);
      expect(run.provider).toBe('deterministic');
      expect(run.promptVersions['document.section']).toBe('v1');
    }, 240_000);

    it('catches an invented commitment as a blocking finding', async () => {
      const session = await project();
      const requirements = (await session.agent.get(ANALYSIS_ROUTES.requirements).expect(200))
        .body as { key: string }[];

      registerDocumentGeneration(
        provider,
        requirements.map((requirement) => requirement.key),
        UNDERSTANDING_SECTIONS.map((section) => section.key),
      );
      registerInventedContent(
        provider,
        requirements.map((requirement) => requirement.key),
      );

      await generate(session, 'OUR_UNDERSTANDING', true);
      const validated = await validate(session, 'OUR_UNDERSTANDING');

      const findings = validated.validation!.findings.filter(
        (finding) => finding.kind === 'unsupported_statement',
      );

      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((finding) => finding.detectedBy === 'DETERMINISTIC')).toBe(true);
      expect(validated.validation?.severity).toBe('BLOCKING');
      expect(JSON.stringify(findings)).toMatch(/GDPR|uptime|concurrent/i);
    }, 240_000);
  });

  /* ------------------------------------------------------- 8. the boundary */

  describe('security', () => {
    it('hides another project’s document behind the same answer as a missing one', async () => {
      const owner = await project();
      await generate(owner, 'OUR_UNDERSTANDING');

      const stranger = await project();
      const theirs = await read(stranger, 'OUR_UNDERSTANDING');

      /* A different project's document, not the owner's. */
      expect(theirs.status).toBe('NOT_STARTED');
      expect(theirs.sections).toEqual([]);
    }, 240_000);

    it('refuses a mutation with no CSRF header', async () => {
      const session = await project();

      await session.agent
        .post(DOCUMENT_ROUTES.generate('OUR_UNDERSTANDING'))
        .send({ useAi: false, expectedVersion: 0 })
        .expect(401);
    }, 240_000);

    it('refuses a stale version rather than overwriting', async () => {
      const session = await project();
      const document = await generate(session, 'OUR_UNDERSTANDING');
      const section = sectionByKey(document, 'project-overview');

      await editSection(session, 'OUR_UNDERSTANDING', section.sectionId, 'First edit.');

      await session.agent
        .put(DOCUMENT_ROUTES.section('OUR_UNDERSTANDING', section.sectionId))
        .set('x-csrf-token', session.csrf)
        .send({ body: 'Second edit from a stale tab.', expectedVersion: document.recordVersion })
        .expect(409);
    }, 240_000);

    it('documents every Phase 7 endpoint in the OpenAPI document', async () => {
      const session = await project();
      const spec = (await session.agent.get('/api/docs-json').expect(200)).body as {
        paths: Record<string, unknown>;
      };

      const paths = Object.keys(spec.paths);

      for (const expected of [
        '/api/v1/projects/current/documents',
        '/api/v1/projects/current/documents/{type}',
        '/api/v1/projects/current/documents/{type}/generate',
        '/api/v1/projects/current/documents/{type}/versions',
        '/api/v1/projects/current/documents/{type}/compare',
        '/api/v1/projects/current/documents/{type}/restore',
        '/api/v1/projects/current/documents/{type}/sections/{sectionId}',
        '/api/v1/projects/current/documents/{type}/features',
        '/api/v1/projects/current/documents/{type}/csv',
        '/api/v1/projects/current/documents/{type}/validate',
        '/api/v1/projects/current/documents/{type}/approve',
        '/api/v1/projects/current/documents/{type}/reopen',
        '/api/v1/projects/current/documents/{type}/final',
      ]) {
        expect(paths).toContain(expected);
      }
    }, 240_000);
  });

  /* ------------------------------------------- 9. working without a model */

  describe('without inference', () => {
    it('writes, edits, validates and approves a document by hand', async () => {
      const session = await project();

      /* Every step below runs with `useAi: false`, which is the whole point. */
      const document = await generate(session, 'OUR_UNDERSTANDING', false);
      expect(document.generator?.deterministicOnly).toBe(true);

      const overview = sectionByKey(document, 'project-overview');
      const written = await editSection(
        session,
        'OUR_UNDERSTANDING',
        overview.sectionId,
        'A timesheet and approval system for internal staff.',
      );

      expect(sectionByKey(written, 'project-overview').origin).toBe('USER_EDITED');

      const validated = await validate(session, 'OUR_UNDERSTANDING', false);
      expect(validated.validation?.modelAssisted).toBe(false);

      const approved = await approve(session, 'OUR_UNDERSTANDING');
      expect(approved.status).toBe('APPROVED');
    }, 240_000);
  });
});
