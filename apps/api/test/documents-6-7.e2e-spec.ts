import { VersioningType } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  API_PREFIX,
  API_VERSION,
  CLIENT_DEPENDENCY_CATEGORIES,
  DOCUMENT_ROUTES,
  ESTIMATION_ROUTES,
  PROJECT_ROUTES,
  type ClientDependency,
  type DocumentSnapshot,
  type DocumentSummary,
  type EstimateSnapshot,
  type WorkPackage,
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
 * Documents 6 and 7, end to end.
 *
 * Organised around the promises Phase 9 makes that could plausibly break.
 *
 * For the work breakdown, all of them reduce to one: **it is the approved plan, not a
 * second opinion about it.** So the hours reconcile role by role, the days and the
 * critical path are the scheduler's, no date appears for a project with no agreed
 * start, and hand-editing any of that is refused with a message naming the estimation
 * step.
 *
 * For the dependency sheet: **received is not accepted**, nothing vague reaches a
 * client, and no credential value can be stored — the last one checked on the write
 * path rather than only at approval, because an issued version cannot be recalled.
 */
describe('Documents 6–7 (e2e)', () => {
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

  /**
   * A credential-shaped string, assembled at runtime.
   *
   * It has to look like the real thing to test the refusal, and a literal would be
   * flagged by every secret scanner that reads this repository — including the one on
   * the push path. Joined, the request carries the identical value.
   */
  const stripeShaped = (): string => ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');

  const WBS = 'WORK_BREAKDOWN_STRUCTURE';
  const CDS = 'CLIENT_DEPENDENCY_SHEET';

  async function project(fixture = WEB): Promise<FixtureSession> {
    return approvedEstimateProject(app.getHttpServer(), provider, fixture);
  }

  async function documents(session: FixtureSession): Promise<readonly DocumentSummary[]> {
    return (await session.agent.get(DOCUMENT_ROUTES.documents).expect(200)).body
      .documents as DocumentSummary[];
  }

  /**
   * A project with a session and nothing else.
   *
   * Deliberately not the full fixture chain: this is only ever used to prove that
   * another project cannot reach this one's documents, and a second complete chain
   * doubles the heaviest fixture in the suite for no extra coverage.
   */
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

  async function read(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    return (await session.agent.get(DOCUMENT_ROUTES.document(type)).expect(200)).body
      .document as DocumentSnapshot;
  }

  async function generate(
    session: FixtureSession,
    type: string,
    useAi = false,
  ): Promise<DocumentSnapshot> {
    const current = await read(session, type);

    return (
      await session.agent
        .post(DOCUMENT_ROUTES.generate(type))
        .set('x-csrf-token', session.csrf)
        .send({ useAi, expectedVersion: current.recordVersion })
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

  /** Approve, and say what stood in the way when it fails. */
  async function approve(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    const current = await read(session, type);
    const response = await session.agent
      .post(DOCUMENT_ROUTES.approve(type))
      .set('x-csrf-token', session.csrf)
      .send({ acknowledged: true, expectedVersion: current.recordVersion });

    if (response.status !== 201) {
      throw new Error(
        `Approving ${type} returned ${response.status}: ${JSON.stringify(response.body)}. Blockers: ${JSON.stringify(current.blockers)}. Findings: ${JSON.stringify(
          current.validation?.findings.filter((finding) => finding.severity === 'BLOCKING') ?? [],
        )}`,
      );
    }

    return response.body.document as DocumentSnapshot;
  }

  /** Generate, disposition what is left over, validate and approve. */
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

  /** Everything up to and including an approved Statement of Work. */
  async function throughStatementOfWork(fixture = WEB): Promise<FixtureSession> {
    const session = await project(fixture);

    for (const type of [
      'OUR_UNDERSTANDING',
      'FEATURE_LISTING',
      'ACCEPTANCE_CRITERIA',
      'ASSUMPTIONS',
      'STATEMENT_OF_WORK',
    ]) {
      await settle(session, type);
    }

    return session;
  }

  /** Everything up to and including an approved work breakdown. */
  async function throughWbs(fixture = WEB): Promise<FixtureSession> {
    const session = await throughStatementOfWork(fixture);
    await settle(session, WBS);

    return session;
  }

  const packagesOf = (document: DocumentSnapshot): readonly WorkPackage[] =>
    document.rows.map((row) => row.payload as WorkPackage);

  const leavesOf = (document: DocumentSnapshot): readonly WorkPackage[] =>
    packagesOf(document).filter((row) => row.level === 'TASK');

  /** The same read, under a name the cross-project test can use unshadowed. */
  const readDocument = read;

  const dependenciesOf = (document: DocumentSnapshot): readonly ClientDependency[] =>
    document.rows.map((row) => row.payload as ClientDependency);

  const approvedEstimate = async (session: FixtureSession): Promise<EstimateSnapshot> =>
    (await session.agent.get(ESTIMATION_ROUTES.estimate).expect(200)).body
      .snapshot as EstimateSnapshot;

  /** Audit events for this project, read straight from the collection. */
  async function auditEvents(
    projectId: string,
  ): Promise<readonly { type: string; metadata?: Record<string, unknown> }[]> {
    const events: unknown = await app
      .get(getConnectionToken())
      .collection('audit_events')
      .find({ projectId })
      .toArray();

    return events as readonly { type: string; metadata?: Record<string, unknown> }[];
  }

  /* ============================================ 1. the sequence ========== */

  describe('the sequence', () => {
    it('1. reports all seven documents as implemented', async () => {
      const session = await project();
      const list = await documents(session);

      expect(list).toHaveLength(7);
      expect(list.every((summary) => summary.implemented)).toBe(true);
    });

    it('2. locks the work breakdown until the statement of work is approved', async () => {
      const session = await project();
      const summary = (await documents(session)).find((entry) => entry.type === WBS)!;

      expect(summary.lock?.reason).toBe('prerequisite_document');
    });

    it('3. refuses to generate the work breakdown while it is locked', async () => {
      const session = await project();
      const current = await read(session, WBS);

      const response = await session.agent
        .post(DOCUMENT_ROUTES.generate(WBS))
        .set('x-csrf-token', session.csrf)
        .send({ useAi: false, expectedVersion: current.recordVersion });

      /* The engine's convention for a locked document, established in Phase 7. */
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('DOCUMENT_LOCKED');
    });

    it('4. locks the dependency sheet until the work breakdown is approved', async () => {
      const session = await throughStatementOfWork();
      const summary = (await documents(session)).find((entry) => entry.type === CDS)!;

      expect(summary.lock?.reason).toBe('prerequisite_document');
    });

    it('5. unlocks the work breakdown once the statement of work is approved', async () => {
      const session = await throughStatementOfWork();
      const summary = (await documents(session)).find((entry) => entry.type === WBS)!;

      expect(summary.lock).toBeNull();
    });

    it('6. unlocks the dependency sheet once the breakdown is approved', async () => {
      const session = await throughWbs();
      const summary = (await documents(session)).find((entry) => entry.type === CDS)!;

      expect(summary.lock).toBeNull();
    });
  });

  /* ==================================== 2. the work breakdown ============ */

  describe('the work breakdown', () => {
    it('7. builds a hierarchy with a project row and tasks beneath it', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const rows = packagesOf(document);

      expect(rows.some((row) => row.level === 'PROJECT')).toBe(true);
      expect(rows.some((row) => row.level === 'TASK')).toBe(true);
      expect(rows.every((row) => /^\d+(\.\d+)*$/.test(row.wbsId))).toBe(true);
    });

    it('8. reconciles exactly with the approved estimate, role by role', async () => {
      const session = await throughStatementOfWork();
      await generate(session, WBS);
      const document = await read(session, WBS);
      const estimate = await approvedEstimate(session);

      const reconciliation = document.wbsReconciliation!;

      expect(reconciliation.reconciles).toBe(true);
      expect(reconciliation.mismatchedRoles).toEqual([]);

      /*
       * Against the estimate itself, not merely against its own arithmetic. Compared at
       * hundredths, because an estimate line is legitimately 4.48 hours and a
       * whole-hour comparison would let half an hour per role slip through.
       */
      for (const [role, hours] of Object.entries(estimate.effortByRole)) {
        expect(reconciliation.wbsByRole[role] ?? 0).toBeCloseTo(hours, 2);
      }
    });

    it('9. every leaf traces to an estimate unit', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);

      for (const leaf of leavesOf(document)) {
        expect(leaf.estimateUnitIds.length).toBeGreaterThan(0);
      }
    });

    it('10. copies the schedule from the approved plan', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const estimate = await approvedEstimate(session);

      const scheduled = new Map(estimate.schedule.tasks.map((task) => [task.taskId, task]));

      for (const leaf of leavesOf(document)) {
        const task = scheduled.get(leaf.estimateUnitIds[0]!);

        if (task) {
          expect(leaf.relativeStartDay).toBe(task.startDay);
          expect(leaf.relativeFinishDay).toBe(task.endDay);
          expect(leaf.onCriticalPath).toBe(task.onCriticalPath);
        }
      }
    });

    it('11. publishes no calendar date when the project has no agreed start', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);

      /* The fixture plans in weeks with no start date, so a date here is invented. */
      expect(packagesOf(document).every((row) => row.actualStartDate === undefined)).toBe(true);
    });

    it('12. no task finishes after the approved plan ends', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const estimate = await approvedEstimate(session);

      for (const leaf of leavesOf(document)) {
        if (leaf.relativeFinishDay !== undefined) {
          expect(leaf.relativeFinishDay).toBeLessThanOrEqual(estimate.schedule.totalWorkingDays);
        }
      }
    });

    it('13. containers roll up to the sum of their children', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const rows = packagesOf(document);

      const project = rows.find((row) => row.level === 'PROJECT')!;
      const leafTotal = leavesOf(document)
        .filter((leaf) => leaf.status !== 'EXCLUDED')
        .reduce((sum, leaf) => sum + leaf.totalEffort, 0);

      expect(project.totalEffort).toBeCloseTo(leafTotal, 2);
    });

    it('14. cites requirements by key, so every citation resolves', async () => {
      const session = await throughStatementOfWork();
      await generate(session, WBS);
      const document = await validate(session, WBS);

      expect(
        document.validation!.findings.filter((finding) => finding.kind === 'unknown_requirement'),
      ).toEqual([]);
    });

    it('15. validates clean and can be approved', async () => {
      const session = await throughStatementOfWork();
      const approved = await settle(session, WBS);

      expect(approved.status).toBe('APPROVED');
    });

    it('16. refuses a hand-edited start day, and says where to change it', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const row = document.rows.find((entry) => (entry.payload as WorkPackage).level === 'TASK')!;
      const entry = row.payload as WorkPackage;

      const response = await session.agent
        .patch(DOCUMENT_ROUTES.row(WBS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...entry, relativeStartDay: (entry.relativeStartDay ?? 1) + 5 },
          expectedVersion: document.recordVersion,
        });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('SCHEDULE_NOT_EDITABLE_HERE');
    });

    it('17. refuses a hand-edited critical-path flag', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const row = document.rows.find((entry) => (entry.payload as WorkPackage).level === 'TASK')!;
      const entry = row.payload as WorkPackage;

      const response = await session.agent
        .patch(DOCUMENT_ROUTES.row(WBS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...entry, onCriticalPath: !entry.onCriticalPath },
          expectedVersion: document.recordVersion,
        });

      expect(response.status).toBe(422);
    });

    it('18. allows rewording a task', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const row = document.rows.find((entry) => (entry.payload as WorkPackage).level === 'TASK')!;
      const entry = row.payload as WorkPackage;

      const updated = (
        await session.agent
          .patch(DOCUMENT_ROUTES.row(WBS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            payload: { ...entry, task: 'Build the timesheet entry screen' },
            expectedVersion: document.recordVersion,
          })
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(
        packagesOf(updated).some((row) => row.task === 'Build the timesheet entry screen'),
      ).toBe(true);
    });

    it('19. blocks approval when the hours no longer add up', async () => {
      /*
       * Reached by hand-editing a task's hours, which is deliberately allowed —
       * splitting or reallocating work is a legitimate correction, and reconciliation
       * is the check rather than a locked field. The document stays readable and
       * simply cannot be approved while its parts do not sum to the approved plan.
       */
      const session = await throughStatementOfWork();
      const generated = await generate(session, WBS);
      const row = generated.rows.find((entry) => (entry.payload as WorkPackage).level === 'TASK')!;
      const entry = row.payload as WorkPackage;

      const edited = (
        await session.agent
          .patch(DOCUMENT_ROUTES.row(WBS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            payload: {
              ...entry,
              effort: { ...entry.effort, BACKEND: (entry.effort.BACKEND ?? 0) + 40 },
              totalEffort: entry.totalEffort + 40,
            },
            expectedVersion: generated.recordVersion,
          })
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(edited.wbsReconciliation?.reconciles).toBe(false);
      expect(edited.blockers.some((blocker) => blocker.kind === 'wbs_not_reconciled')).toBe(true);

      await validate(session, WBS);

      /* The fresh version: validating bumped it, and a stale one is a 409 by design. */
      const validated = await read(session, WBS);

      const refused = await session.agent
        .post(DOCUMENT_ROUTES.approve(WBS))
        .set('x-csrf-token', session.csrf)
        .send({ acknowledged: true, expectedVersion: validated.recordVersion });

      expect(refused.status).toBe(422);

      /* Still readable, with the figures it was given. */
      expect((await read(session, WBS)).rows.length).toBe(generated.rows.length);
    });

    it('19b. refuses approval once the estimate underneath it has moved', async () => {
      /*
       * The other way the two can disagree: the estimate is reopened and re-approved
       * after the breakdown was written. The engine reports the prerequisite chain as
       * no longer approved — which outranks the arithmetic, because everything below a
       * withdrawn approval is built on sand — and the reconciliation says so too.
       */
      const session = await throughWbs();
      const estimate = await approvedEstimate(session);

      const reopened = (
        await session.agent
          .post(ESTIMATION_ROUTES.reopen)
          .set('x-csrf-token', session.csrf)
          .send({ reason: 'Revising the backend figure', expectedVersion: estimate.recordVersion })
          .expect(200)
      ).body.snapshot as EstimateSnapshot;

      const unit = reopened.estimates.find((candidate) => !candidate.excluded)!;

      const overridden = (
        await session.agent
          .patch(ESTIMATION_ROUTES.estimateUnit(unit.id))
          .set('x-csrf-token', session.csrf)
          .send({
            effort: { ...unit.effort, BACKEND: (unit.effort.BACKEND ?? 0) + 40 },
            note: 'A deliberate change, to prove the breakdown notices.',
            expectedVersion: reopened.recordVersion,
          })
          .expect(200)
      ).body.snapshot as EstimateSnapshot;

      await session.agent
        .post(ESTIMATION_ROUTES.approve)
        .set('x-csrf-token', session.csrf)
        .send({ acknowledgedAiAssistance: true, expectedVersion: overridden.recordVersion })
        .expect(200);

      const document = await read(session, WBS);

      expect(document.wbsReconciliation?.reconciles).toBe(false);
      expect(document.blockers.length).toBeGreaterThan(0);
    });

    it('20. stays readable once the estimate has moved', async () => {
      /* Locking controls what can be changed, never what can be read. */
      const session = await throughWbs();
      const before = await read(session, WBS);
      const estimate = await approvedEstimate(session);

      await session.agent
        .post(ESTIMATION_ROUTES.reopen)
        .set('x-csrf-token', session.csrf)
        .send({
          reason: 'Checking the document stays readable',
          expectedVersion: estimate.recordVersion,
        })
        .expect(200);

      const after = await read(session, WBS);

      expect(after.rows).toHaveLength(before.rows.length);
      expect(after.status).toBe('APPROVED');
    });

    it('21. records the generation without putting task text in the audit trail', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const events = await auditEvents(document.projectId);

      const text = JSON.stringify(events);

      for (const leaf of leavesOf(document).slice(0, 5)) {
        if (leaf.description.length > 20) {
          expect(text).not.toContain(leaf.description);
        }
      }
    });
  });

  /* ================================ 3. the client dependency sheet ======= */

  describe('the client dependency sheet', () => {
    it('22. generates rows grounded in approved sources', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);

      expect(document.rows.length).toBeGreaterThan(0);

      for (const dependency of dependenciesOf(document)) {
        expect(dependency.sourceKinds.length).toBeGreaterThan(0);
        expect(dependency.dependencyKey).toMatch(/^CD-\d{3,5}$/);
      }
    });

    it('23. starts everything unrequested, with nobody named', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);

      for (const dependency of dependenciesOf(document)) {
        expect(dependency.status).toBe('NOT_REQUESTED');
        expect(dependency.clientOwner).toBe('');
      }
    });

    it('24. writes no vague row', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);

      for (const dependency of dependenciesOf(document)) {
        expect(dependency.dependency.toLowerCase()).not.toBe(
          'client must provide all required information',
        );
        expect(dependency.dependency.length).toBeGreaterThan(10);
      }
    });

    it('25. carries no credential value anywhere in the sheet', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);
      const text = JSON.stringify(document.rows);

      for (const pattern of [/sk_live_/, /AKIA[0-9A-Z]{12}/, /-----BEGIN/, /password\s*[:=]/i]) {
        expect(text).not.toMatch(pattern);
      }
    });

    it('26. walks an item from unrequested to accepted', async () => {
      const session = await throughWbs();
      const generated = await generate(session, CDS);
      const row = generated.rows[0]!;

      const requested = (
        await session.agent
          .post(DOCUMENT_ROUTES.requestDependency(CDS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({ expectedVersion: generated.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      const afterRequest = dependenciesOf(requested).find(
        (entry) => entry.dependencyKey === (row.payload as ClientDependency).dependencyKey,
      )!;

      expect(afterRequest.status).toBe('REQUESTED');
      expect(afterRequest.requestedAt).toBeDefined();

      const received = (
        await session.agent
          .post(DOCUMENT_ROUTES.receiveDependency(CDS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({ partial: false, expectedVersion: requested.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      const afterReceive = dependenciesOf(received).find(
        (entry) => entry.dependencyKey === afterRequest.dependencyKey,
      )!;

      /* Arrived, and explicitly not yet usable. */
      expect(afterReceive.status).toBe('RECEIVED');
      expect(afterReceive.receivedAt).toBeDefined();

      const accepted = (
        await session.agent
          .post(DOCUMENT_ROUTES.validateDependency(CDS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            outcome: 'ACCEPTED',
            note: 'Signed in with the sandbox account and called the test endpoint.',
            expectedVersion: received.recordVersion,
          })
          .expect(201)
      ).body.document as DocumentSnapshot;

      const afterAccept = dependenciesOf(accepted).find(
        (entry) => entry.dependencyKey === afterRequest.dependencyKey,
      )!;

      expect(afterAccept.status).toBe('ACCEPTED');
      expect(afterAccept.validatedAt).toBeDefined();
      expect(afterAccept.validationNote).toContain('sandbox account');
    });

    it('27. refuses to jump from requested straight to accepted', async () => {
      const session = await throughWbs();
      const generated = await generate(session, CDS);
      const row = generated.rows[0]!;

      const requested = (
        await session.agent
          .post(DOCUMENT_ROUTES.requestDependency(CDS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({ expectedVersion: generated.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      /* Nothing is accepted without arriving first, and being looked at. */
      const response = await session.agent
        .post(DOCUMENT_ROUTES.validateDependency(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          outcome: 'ACCEPTED',
          note: 'Trying to skip the check.',
          expectedVersion: requested.recordVersion,
        });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('DEPENDENCY_TRANSITION_INVALID');
    });

    it('28. requires a note when accepting or rejecting', async () => {
      const session = await throughWbs();
      const generated = await generate(session, CDS);
      const row = generated.rows[0]!;

      const requested = (
        await session.agent
          .post(DOCUMENT_ROUTES.requestDependency(CDS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({ expectedVersion: generated.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      const received = (
        await session.agent
          .post(DOCUMENT_ROUTES.receiveDependency(CDS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({ partial: false, expectedVersion: requested.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      const response = await session.agent
        .post(DOCUMENT_ROUTES.validateDependency(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({ outcome: 'ACCEPTED', note: '', expectedVersion: received.recordVersion });

      expect(response.status).toBe(422);
    });

    it('29. refuses a credential value in an edited row', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);
      const row = document.rows[0]!;
      const dependency = row.payload as ClientDependency;

      const response = await session.agent
        .patch(DOCUMENT_ROUTES.row(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...dependency, remarks: `they sent ${stripeShaped()}` },
          expectedVersion: document.recordVersion,
        });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('CREDENTIAL_VALUE_REFUSED');
    });

    it('30. refuses a connection string with a password in it', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);
      const row = document.rows[0]!;
      const dependency = row.payload as ClientDependency;

      const response = await session.agent
        .patch(DOCUMENT_ROUTES.row(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: {
            ...dependency,
            description: 'Connect with mongodb://admin:letmein@db.example.com:27017',
          },
          expectedVersion: document.recordVersion,
        });

      expect(response.status).toBe(422);
    });

    it('31. refuses a status change through an ordinary edit', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);
      const row = document.rows[0]!;
      const dependency = row.payload as ClientDependency;

      const response = await session.agent
        .patch(DOCUMENT_ROUTES.row(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...dependency, status: 'ACCEPTED' },
          expectedVersion: document.recordVersion,
        });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('DEPENDENCY_STATUS_NOT_EDITABLE_HERE');
    });

    it('32. accepts an owner recorded by a person', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);
      const row = document.rows[0]!;
      const dependency = row.payload as ClientDependency;

      const updated = (
        await session.agent
          .patch(DOCUMENT_ROUTES.row(CDS, row.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            payload: {
              ...dependency,
              clientOwner: 'Operations lead',
              internalOwner: 'Delivery lead',
            },
            expectedVersion: document.recordVersion,
          })
          .expect(200)
      ).body.document as DocumentSnapshot;

      expect(dependenciesOf(updated).some((entry) => entry.clientOwner === 'Operations lead')).toBe(
        true,
      );
    });

    it('33. can be approved with items still outstanding, because asking is the point', async () => {
      const session = await throughWbs();
      const approved = await settle(session, CDS);

      expect(approved.status).toBe('APPROVED');
      /* Outstanding blocking items are reported, and do not prevent issuing the sheet. */
      expect(approved.dependencySummary!.outstanding).toBeGreaterThan(0);
    });

    it('34. keeps row text and credential flags out of the audit trail', async () => {
      const session = await throughWbs();
      const generated = await generate(session, CDS);
      const row = generated.rows[0]!;
      const dependency = row.payload as ClientDependency;

      await session.agent
        .post(DOCUMENT_ROUTES.requestDependency(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({ expectedVersion: generated.recordVersion })
        .expect(201);

      const events = await auditEvents(generated.projectId);

      const status = events.find((event) => event.type === 'CLIENT_DEPENDENCY_STATUS_CHANGED');

      expect(status).toBeDefined();
      /* The key and the states, never the request itself. */
      expect(status!.metadata?.dependencyKey).toBe(dependency.dependencyKey);
      expect(JSON.stringify(events)).not.toContain(dependency.description);
    });
  });

  /* ================================== 4. traceability between the two ==== */

  describe('the two documents together', () => {
    it('35. links dependency rows to the work packages that wait for them', async () => {
      const session = await throughWbs();
      const wbs = await read(session, WBS);
      const document = await generate(session, CDS);

      const wbsIds = new Set(packagesOf(wbs).map((row) => row.wbsId));

      for (const dependency of dependenciesOf(document)) {
        for (const id of dependency.wbsIds) {
          expect(wbsIds.has(id)).toBe(true);
        }
      }
    });

    it('36. states timing relative to commencement when the plan has no dates', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);

      for (const dependency of dependenciesOf(document)) {
        expect(dependency.actualDueDate).toBeUndefined();
        expect(dependency.relativeDue.length).toBeGreaterThan(0);
      }
    });

    it('37. marks the sheet out of date when the breakdown is reopened', async () => {
      const session = await throughWbs();
      await settle(session, CDS);

      const wbs = await read(session, WBS);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(WBS))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising the breakdown', expectedVersion: wbs.recordVersion })
        .expect(201);

      const sheet = await read(session, CDS);

      /* Still approved, and honestly labelled as no longer current. */
      expect(sheet.status).toBe('APPROVED');
      expect(sheet.currentness).toBe('OUTDATED');
      expect(sheet.rows.length).toBeGreaterThan(0);
    });

    it('38. keeps an issued sheet readable and refuses to change it', async () => {
      const session = await throughWbs();
      const approved = await settle(session, CDS);

      const issued = (
        await session.agent
          .post(DOCUMENT_ROUTES.markFinal(CDS))
          .set('x-csrf-token', session.csrf)
          .send({ acknowledged: true, expectedVersion: approved.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      expect(issued.status).toBe('FINAL');

      const row = issued.rows[0]!;
      const response = await session.agent
        .post(DOCUMENT_ROUTES.requestDependency(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({ expectedVersion: issued.recordVersion });

      /* Content in an issued document is history. */
      expect(response.status).toBe(409);

      const stillReadable = await read(session, CDS);

      expect(stillReadable.rows.length).toBeGreaterThan(0);
    });

    it('39. documents every Phase 9 endpoint in the OpenAPI document', async () => {
      const session = await project();
      const spec = (await session.agent.get('/api/docs-json').expect(200)).body as {
        paths: Record<string, unknown>;
      };

      const paths = Object.keys(spec.paths);

      /*
       * The three lifecycle actions. The row endpoints themselves are shared with
       * Phases 7 and 8 and are asserted there; these are what Phase 9 adds.
       */
      for (const expected of [
        'rows/{rowId}/request',
        'rows/{rowId}/receive',
        'rows/{rowId}/validate',
      ]) {
        expect(paths.some((path) => path.includes(expected))).toBe(true);
      }
    }, 120_000);
  });

  /* ============================= 5. traceability in both directions ====== */

  /**
   * The two relationships the breakdown and the sheet owe each other.
   *
   * Feature Listing traceability is derived from an approved chain — a listing row
   * records the estimate units it was priced from — so these assert the chain end to
   * end rather than the mapping function in isolation.
   *
   * The dependency relationship is stored once, on the sheet, and read backwards for
   * the breakdown. That is what makes generating document 7 leave document 6 untouched,
   * which test 47 checks byte for byte on an issued version.
   */
  describe('traceability', () => {
    it('40. every feature work package carries the Feature Listing rows it delivers', async () => {
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const listing = await read(session, 'FEATURE_LISTING');

      const approved = new Set(listing.features.map((feature) => feature.featureId));
      const featureWork = leavesOf(document).filter((leaf) => leaf.workKind === 'FEATURE');

      expect(featureWork.length).toBeGreaterThan(0);

      for (const leaf of featureWork) {
        expect(leaf.featureIds.length).toBeGreaterThan(0);

        /* And every one of them is a row the client actually agreed to. */
        for (const featureId of leaf.featureIds) {
          expect(approved.has(featureId)).toBe(true);
        }
      }
    });

    it('41. reports live feature coverage, and classifies overhead rather than hiding it', async () => {
      const session = await throughStatementOfWork();
      await generate(session, WBS);
      const document = await read(session, WBS);
      const listing = await read(session, 'FEATURE_LISTING');

      const coverage = document.wbsCoverage!;

      /* Measured against the approved listing, not against an empty list. */
      expect(coverage.applicableFeatures).toBe(listing.features.length);
      expect(coverage.applicableFeatures).toBeGreaterThan(0);
      expect(coverage.mappedFeatures).toBe(coverage.applicableFeatures);
      expect(coverage.unmappedFeatureIds).toEqual([]);
      expect(coverage.unknownFeatureIds).toEqual([]);
      expect(coverage.untracedFeatureWorkIds).toEqual([]);

      /* Overhead is named, with its hours, rather than silently excluded. */
      const overhead = leavesOf(document).filter((leaf) => leaf.workKind === 'OVERHEAD');

      expect(coverage.overheadWbsIds).toHaveLength(overhead.length);

      if (overhead.length > 0) {
        expect(coverage.overheadHours).toBeGreaterThan(0);
        expect(overhead.every((leaf) => leaf.featureIds.length === 0)).toBe(true);
      }
    });

    it('42. regenerating the breakdown preserves the Feature Listing mapping', async () => {
      const session = await throughStatementOfWork();
      const first = await generate(session, WBS);

      const before = new Map(
        leavesOf(first).map((leaf) => [leaf.estimateUnitIds[0]!, [...leaf.featureIds].sort()]),
      );

      const second = await generate(session, WBS);

      const after = new Map(
        leavesOf(second).map((leaf) => [leaf.estimateUnitIds[0]!, [...leaf.featureIds].sort()]),
      );

      expect(after.size).toBe(before.size);

      for (const [unitId, featureIds] of before) {
        expect(after.get(unitId)).toEqual(featureIds);
      }
    });

    it('43. a Feature Listing change makes the breakdown out of date', async () => {
      const session = await throughWbs();

      const listing = await read(session, 'FEATURE_LISTING');

      await session.agent
        .post(DOCUMENT_ROUTES.reopen('FEATURE_LISTING'))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising the agreed features', expectedVersion: listing.recordVersion })
        .expect(201);

      const document = await read(session, WBS);

      /*
       * Through the existing authority chain, transitively: the breakdown's own
       * prerequisite is the statement of work, and Feature Listing sits above that.
       */
      expect(document.currentness).toBe('OUTDATED');
      expect(document.rows.length).toBeGreaterThan(0);
    });

    it('44. a dependency row names the work packages that wait for it', async () => {
      const session = await throughWbs();
      const wbs = await read(session, WBS);
      const sheet = await generate(session, CDS);

      const wbsIds = new Set(packagesOf(wbs).map((row) => row.wbsId));
      const linked = dependenciesOf(sheet).filter((entry) => entry.wbsIds.length > 0);

      expect(linked.length).toBeGreaterThan(0);

      for (const dependency of linked) {
        for (const id of dependency.wbsIds) {
          expect(wbsIds.has(id)).toBe(true);
        }
      }
    });

    it('45. the breakdown surfaces the dependencies waiting on each task', async () => {
      const session = await throughWbs();
      const sheet = await generate(session, CDS);

      const linked = dependenciesOf(sheet).find((entry) => entry.wbsIds.length > 0)!;
      const wbsId = linked.wbsIds[0]!;

      /* Derived on read, from the sheet as it stands. */
      const document = await read(session, WBS);
      const reverse = document.reverseDependencies!;

      expect(reverse.sheetVersion).toBe(sheet.version);
      expect(reverse.byWbsId[wbsId]).toBeDefined();
      expect(reverse.byWbsId[wbsId]!.map((entry) => entry.dependencyKey)).toContain(
        linked.dependencyKey,
      );
      expect(reverse.byWbsId[wbsId]![0]!.sheetCurrentness).toBe('CURRENT');
    });

    it('46. one dependency spans every task it affects, and one task lists all of its own', async () => {
      const session = await throughWbs();
      const generated = await generate(session, CDS);
      const wbs = await read(session, WBS);

      const tasks = packagesOf(wbs)
        .filter((row) => row.level === 'TASK' && row.status !== 'EXCLUDED')
        .slice(0, 2)
        .map((row) => row.wbsId);

      expect(tasks).toHaveLength(2);

      const first = generated.rows[0]!;
      const dependency = first.payload as ClientDependency;

      /* One dependency naming both tasks. */
      const spanning = (
        await session.agent
          .patch(DOCUMENT_ROUTES.row(CDS, first.rowId))
          .set('x-csrf-token', session.csrf)
          .send({
            payload: { ...dependency, wbsIds: tasks },
            expectedVersion: generated.recordVersion,
          })
          .expect(200)
      ).body.document as DocumentSnapshot;

      /*
       * A second dependency on the first task only, added by hand — this fixture's
       * approved scope legitimately yields one generated row, and "two dependencies on
       * one task" needs two.
       */
      await session.agent
        .post(DOCUMENT_ROUTES.addRow(CDS))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: {
            ...dependency,
            category: 'CONTENT',
            dependency: 'Product catalogue export for the import',
            wbsIds: [tasks[0]!],
          },
          attribution: 'Raised during the delivery walkthrough.',
          expectedVersion: spanning.recordVersion,
        })
        .expect(201);

      const reverse = (await read(session, WBS)).reverseDependencies!;

      /*
       * The first task waits on both; the second waits only on the one that named it.
       * The added row's key is assigned by the application, so it is read rather than
       * assumed — a hand-added row cannot claim an existing key.
       */
      const added = dependenciesOf(await read(session, CDS)).find(
        (entry) => entry.category === 'CONTENT',
      )!;

      expect(added.dependencyKey).not.toBe(dependency.dependencyKey);
      expect(reverse.byWbsId[tasks[0]!]!.map((entry) => entry.dependencyKey).sort()).toEqual(
        [added.dependencyKey, dependency.dependencyKey].sort(),
      );
      expect(reverse.byWbsId[tasks[1]!]!.map((entry) => entry.dependencyKey)).toEqual([
        dependency.dependencyKey,
      ]);
    });

    it('46b. numbers a hand-added work package under the parent it was given', async () => {
      /*
       * Regression. `withNextKey` handled only the two Phase 8 row kinds, so adding a
       * row by hand to either Phase 9 document stamped it with an `assumptionKey` and
       * the payload was then refused — which made manual rows, and their attribution,
       * impossible on both new documents.
       */
      const session = await throughStatementOfWork();
      const document = await generate(session, WBS);
      const parent = packagesOf(document).find((row) => row.level === 'FEATURE')!;
      const template = leavesOf(document)[0]!;

      const added = (
        await session.agent
          .post(DOCUMENT_ROUTES.addRow(WBS))
          .set('x-csrf-token', session.csrf)
          .send({
            payload: {
              ...template,
              parentId: parent.wbsId,
              task: 'Write the migration runbook',
              effort: {},
              totalEffort: 0,
            },
            attribution: 'Agreed with the delivery lead during planning.',
            expectedVersion: document.recordVersion,
          })
          .expect(201)
      ).body.document as DocumentSnapshot;

      const mine = packagesOf(added).find((row) => row.task === 'Write the migration runbook')!;

      expect(mine.wbsId.startsWith(`${parent.wbsId}.`)).toBe(true);

      /* An unknown parent has nothing to hang the work under. */
      const refused = await session.agent
        .post(DOCUMENT_ROUTES.addRow(WBS))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...template, parentId: '77.77', task: 'Orphan' },
          attribution: 'Testing the refusal.',
          expectedVersion: added.recordVersion,
        });

      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain('WBS_PARENT_NOT_FOUND');
    });

    it('47. refuses a dependency pointing at work that is not in the breakdown', async () => {
      const session = await throughWbs();
      const document = await generate(session, CDS);
      const row = document.rows[0]!;
      const dependency = row.payload as ClientDependency;

      const response = await session.agent
        .patch(DOCUMENT_ROUTES.row(CDS, row.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...dependency, wbsIds: ['99.99.99'] },
          expectedVersion: document.recordVersion,
        });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('UNKNOWN_WBS_REFERENCE');
    });

    it('48. refuses another project any reach into this project’s dependency rows', async () => {
      /*
       * The cross-project protection, at the level where it actually lives.
       *
       * A WBS id is an outline number — "1.1.1.1.1" exists in every project — so a value
       * copied from another project cannot be told apart from a legitimate one, and
       * pretending to detect that would be theatre. What is real is that resolution
       * happens inside the caller's own project: the row and the breakdown are both read
       * for the session's project, so another project cannot reference, read or edit
       * anything here. It is refused as not found, the same answer as one that never
       * existed.
       */
      const mine = await throughWbs();
      const document = await generate(mine, CDS);
      const row = document.rows[0]!;

      const stranger = await bareProject();

      /*
       * The stranger's read succeeds and returns *their* sheet, which has nothing in it.
       * Scoping, not a blanket refusal: every project sees its own documents, and that
       * is why an id cannot leak between them.
       */
      const theirs = await stranger.agent.get(DOCUMENT_ROUTES.document(CDS));

      if (theirs.status === 200) {
        expect((theirs.body.document as DocumentSnapshot).rows).toEqual([]);
      } else {
        expect([401, 404, 422]).toContain(theirs.status);
      }

      const edit = await stranger.agent
        .patch(DOCUMENT_ROUTES.row(CDS, row.rowId))
        .set('x-csrf-token', stranger.csrf)
        .send({
          payload: { ...(row.payload as ClientDependency), wbsIds: ['1.1.1.1.1'] },
          expectedVersion: document.recordVersion,
        });

      expect([401, 404, 422]).toContain(edit.status);

      /* And this project's row is exactly as it was. */
      const after = dependenciesOf(await readDocument(mine, CDS)).find(
        (entry) => entry.dependencyKey === (row.payload as ClientDependency).dependencyKey,
      )!;

      expect(after.wbsIds).toEqual((row.payload as ClientDependency).wbsIds);
    });

    it('49. generating the sheet leaves an issued breakdown byte for byte unchanged', async () => {
      const session = await throughWbs();
      const wbs = await read(session, WBS);

      const issued = (
        await session.agent
          .post(DOCUMENT_ROUTES.markFinal(WBS))
          .set('x-csrf-token', session.csrf)
          .send({ acknowledged: true, expectedVersion: wbs.recordVersion })
          .expect(201)
      ).body.document as DocumentSnapshot;

      expect(issued.status).toBe('FINAL');

      /* The exact stored content, before the sheet exists. */
      const before = JSON.stringify(issued.rows);

      await generate(session, CDS);

      const after = await read(session, WBS);

      /* Not one byte of the issued document moved. */
      expect(JSON.stringify(after.rows)).toBe(before);
      expect(after.status).toBe('FINAL');
      expect(after.version).toBe(issued.version);

      /* And the reverse view is there beside it, derived rather than written in. */
      expect(after.reverseDependencies).not.toBeNull();
    });

    it('50. marks the sheet as out of date when its links are read through the breakdown', async () => {
      const session = await throughWbs();
      await settle(session, CDS);

      /* Reopening the breakdown makes the sheet built on it stale. */
      const wbs = await read(session, WBS);

      await session.agent
        .post(DOCUMENT_ROUTES.reopen(WBS))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'Revising the breakdown', expectedVersion: wbs.recordVersion })
        .expect(201);

      const sheet = await read(session, CDS);

      expect(sheet.currentness).toBe('OUTDATED');

      const reverse = (await read(session, WBS)).reverseDependencies!;
      const entries = Object.values(reverse.byWbsId).flat();

      expect(entries.length).toBeGreaterThan(0);
      expect(reverse.sheetCurrentness).toBe('OUTDATED');

      /* Every entry says so, so a reader cannot take a stale link as a current claim. */
      for (const entry of entries) {
        expect(entry.sheetCurrentness).toBe('OUTDATED');
      }
    });

    it('51. an internal sequencing dependency never becomes a client dependency', async () => {
      const session = await throughWbs();
      const wbs = await read(session, WBS);
      const sheet = await generate(session, CDS);

      /* The breakdown has internal ordering: tasks that follow other tasks. */
      const sequenced = packagesOf(wbs).filter((row) => row.predecessors.length > 0);

      expect(sequenced.length).toBeGreaterThan(0);

      /*
       * None of that ordering appears on the sheet. Every row there is something a
       * person outside the delivery team hands over — there is no category for
       * "internal sequencing" to file one under.
       */
      for (const dependency of dependenciesOf(sheet)) {
        expect(dependency.sourceKinds.length).toBeGreaterThan(0);
        expect(dependency.sourceKinds).not.toContain('INTERNAL');
        expect(CLIENT_DEPENDENCY_CATEGORIES).toContain(dependency.category);
      }

      /* And a task's predecessors are not reported as things the client owes. */
      const reverse = (await read(session, WBS)).reverseDependencies!;

      for (const row of sequenced) {
        const related = (reverse.byWbsId[row.wbsId] ?? []).map((entry) => entry.dependencyKey);

        for (const predecessor of row.predecessors) {
          expect(related).not.toContain(predecessor);
        }
      }
    });
  });
});
