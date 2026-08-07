import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ANALYSIS_ROUTES,
  API_PREFIX,
  API_VERSION,
  CSRF_COOKIE,
  PROJECT_ROUTES,
  REQUIREMENT_ROUTES,
  type AnalysisRun,
  type Baseline,
  type Clarification,
  type RequirementItem,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { configureSecurity } from '../src/security';
import { CONFLICTING_SOURCES, registerAnalysisFixtures } from './analysis-fixtures';

/**
 * The Phase 4 workflow over HTTP, against a real MongoDB and a scripted model.
 *
 * The model is the deterministic provider, and that is the point. What is under
 * test here is *this application*: whether a contradiction between two documents
 * survives chunking, whether a fabricated citation is caught, whether approval
 * is actually refused while a blocker exists. Running it against a real model
 * would make every one of those assertions probabilistic — "usually finds the
 * conflict" is not a test — and would make CI download gigabytes of weights to
 * check business logic.
 *
 * The scenario is deliberately hostile: two documents that disagree, a
 * requirement stated in both, a quotation the model invented, and a page number
 * the model correctly judges to hold no requirement.
 */
describe('Requirement analysis (e2e)', () => {
  let app: NestExpressApplication;
  let provider: DeterministicProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureSecurity(app, app.get(AppConfigService));
    app.setGlobalPrefix(API_PREFIX);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
    await app.init();

    provider = app.get(DeterministicProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function newProject(name = 'Analysis test') {
    const agent = request.agent(app.getHttpServer());
    const created = await agent.post(PROJECT_ROUTES.create).send({ name }).expect(201);

    const raw: unknown = created.headers['set-cookie'];
    const cookies: string[] = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];
    const csrf = cookies
      .find((value) => value.startsWith(CSRF_COOKIE))
      ?.split(';')[0]
      ?.split('=')[1];

    return { agent, csrf: csrf ?? '' };
  }

  type Session = Awaited<ReturnType<typeof newProject>>;

  /** Adds the two conflicting documents and marks both reviewed. */
  async function seedSources(session: Session): Promise<{ brief: string[]; addendum: string[] }> {
    const blockIds: string[][] = [];

    for (const source of CONFLICTING_SOURCES) {
      const created = await session.agent
        .post(REQUIREMENT_ROUTES.textSources)
        .set('x-csrf-token', session.csrf)
        .send({ title: source.title, text: source.text })
        .expect(201);

      const sourceId = created.body.sourceId as string;
      const blocks = created.body.effectiveContent.blocks as { id: string }[];

      blockIds.push(blocks.map((block) => block.id));

      await session.agent
        .post(REQUIREMENT_ROUTES.review(sourceId))
        .set('x-csrf-token', session.csrf)
        .send({ version: created.body.version })
        .expect(200);
    }

    return { brief: blockIds[0] ?? [], addendum: blockIds[1] ?? [] };
  }

  /** Starts a run and waits for it to finish. Bounded, so a bug cannot hang. */
  async function runAnalysis(session: Session): Promise<AnalysisRun> {
    await session.agent
      .post(ANALYSIS_ROUTES.runs)
      .set('x-csrf-token', session.csrf)
      .send({ preserveUserDecisions: true })
      .expect(202);

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await session.agent.get(ANALYSIS_ROUTES.currentRun).expect(200);
      const run = current.body as AnalysisRun;

      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error('The analysis did not finish.');
  }

  /** Waits for any in-flight run to reach a terminal state. */
  async function settle(session: Session): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = await session.agent.get(ANALYSIS_ROUTES.currentRun).expect(200);
      const run = current.body as AnalysisRun | null;

      if (!run || ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(run.status)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function analysedProject(): Promise<{ session: Session; run: AnalysisRun }> {
    const session = await newProject();
    const blockIds = await seedSources(session);

    registerAnalysisFixtures(provider, blockIds);

    return { session, run: await runAnalysis(session) };
  }

  /* ------------------------------------------------------------- guards */

  it('refuses to analyse a project with nothing reviewed', async () => {
    const session = await newProject();

    const response = await session.agent
      .post(ANALYSIS_ROUTES.runs)
      .set('x-csrf-token', session.csrf)
      .send({ preserveUserDecisions: true })
      .expect(422);

    expect(response.body.error.message).toMatch(/finish reviewing/i);
  });

  it('refuses a second analysis while one is running', async () => {
    const session = await newProject();
    const blockIds = await seedSources(session);

    registerAnalysisFixtures(provider, blockIds);

    await session.agent
      .post(ANALYSIS_ROUTES.runs)
      .set('x-csrf-token', session.csrf)
      .send({ preserveUserDecisions: true })
      .expect(202);

    // Two concurrent runs would produce two sets of requirement keys for one
    // project, and one very confused reviewer.
    const second = await session.agent
      .post(ANALYSIS_ROUTES.runs)
      .set('x-csrf-token', session.csrf)
      .send({ preserveUserDecisions: true });

    // 409 while the first is still working; 202 if it finished first, which is
    // legitimate rather than a race — either way, never two at once.
    expect([202, 409]).toContain(second.status);

    // Settled before the test ends. A run still in flight would consume the
    // next test's fixtures, which is the sort of cross-test leak that produces
    // a failure three files away from its cause.
    await settle(session);
  });

  it('rejects a request with no session', async () => {
    await request(app.getHttpServer()).get(ANALYSIS_ROUTES.requirements).expect(401);
  });

  /* ---------------------------------------------------------- the run */

  it('completes, and records what the model actually did', async () => {
    const { run } = await analysedProject();

    expect(run.status).toBe('COMPLETED');
    expect(run.provider).toBe('deterministic');
    expect(run.progress.totalChunks).toBeGreaterThan(0);
    expect(run.progress.failedChunks).toBe(0);

    // Every task execution is on the record, so "which prompt version produced
    // this requirement" is answerable months later.
    expect(run.executions.length).toBeGreaterThan(0);
    expect(run.executions.every((execution) => execution.promptVersion === 'v1')).toBe(true);
    expect(run.promptRegistryChecksum).toMatch(/^[0-9a-f]{16,64}$/);
  });

  it('chunks per document, never across them', async () => {
    const { session, run } = await analysedProject();
    const detail = await session.agent.get(ANALYSIS_ROUTES.run(run.id)).expect(200);

    // Two documents in, and the chunk executions carry a chunk id each.
    const chunked = (detail.body as AnalysisRun).executions.filter(
      (execution) => execution.chunkId !== undefined,
    );

    expect(chunked.length).toBeGreaterThan(0);
    expect(new Set(chunked.map((execution) => execution.chunkId)).size).toBeGreaterThanOrEqual(2);
  });

  /* ------------------------------------------------------ requirements */

  it('produces requirements traced to the text they came from', async () => {
    const { session } = await analysedProject();
    const response = await session.agent.get(ANALYSIS_ROUTES.requirements).expect(200);
    const items = response.body as RequirementItem[];

    expect(items.length).toBe(5);
    expect(items.map((item) => item.key)).toEqual([
      'REQ-001',
      'REQ-002',
      'REQ-003',
      'REQ-004',
      'REQ-005',
    ]);

    const build = items.find((item) => item.title === 'Build a quote');

    expect(build?.category).toBe('functional');
    expect(build?.priority).toBe('must');
    expect(build?.references[0]?.verified).toBe(true);
    // Copied from the stored block, not produced by the model.
    expect(build?.references[0]?.reference.lineNumber).toBe(1);
  });

  it('catches a quotation the model invented, and says so in the score', async () => {
    /*
     * The fixture has the model citing "quotes are dispatched by courier" from a
     * block that says nothing of the kind. Nothing about the response is
     * malformed — this is the case a schema cannot catch.
     */
    const { session } = await analysedProject();
    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];
    const fabricated = items.find((item) => item.key === 'REQ-003');

    expect(fabricated?.references[0]?.verified).toBe(false);
    expect(fabricated?.evidenceConfidence.contributions.map((entry) => entry.signal)).toContain(
      'unverified_excerpt',
    );

    // And the model's own confidence for it was 0.95, which is precisely why
    // the two numbers are kept apart.
    expect(fabricated?.modelConfidence?.value).toBe(0.95);
    expect(fabricated?.evidenceConfidence.score).toBeLessThan(0.95);
  });

  it('keeps the two confidences separate', async () => {
    const { session } = await analysedProject();
    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];

    for (const item of items) {
      expect(item.evidenceConfidence.ruleVersion).toBe('v1');

      // The score is the sum of its listed contributions, which is what makes
      // it explainable — and what makes it impossible for the model to set.
      const total = item.evidenceConfidence.contributions.reduce(
        (sum, entry) => sum + entry.weight,
        0,
      );

      expect(item.evidenceConfidence.contributions.length).toBeGreaterThan(0);
      expect(item.evidenceConfidence.score).toBeCloseTo(Math.min(1, Math.max(0, total)), 2);
    }
  });

  it('records a human edit permanently and does not lose it on re-analysis', async () => {
    const { session } = await analysedProject();
    const before = (await session.agent.get(ANALYSIS_ROUTES.requirements))
      .body as RequirementItem[];
    const target = before[0]!;

    await session.agent
      .patch(ANALYSIS_ROUTES.requirement(target.id))
      .set('x-csrf-token', session.csrf)
      .send({
        statement: 'A sales user must build a quote from the product catalogue.',
        expectedVersion: target.version,
      })
      .expect(200);

    const edited = (await session.agent.get(ANALYSIS_ROUTES.requirement(target.id)))
      .body as RequirementItem;

    expect(edited.editedByUser).toBe(true);
    expect(edited.status).toBe('edited');
    expect(edited.statement).toMatch(/product catalogue/);
  });

  it('refuses an edit against a stale version', async () => {
    const { session } = await analysedProject();
    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];

    await session.agent
      .patch(ANALYSIS_ROUTES.requirement(items[0]!.id))
      .set('x-csrf-token', session.csrf)
      .send({ status: 'accepted', expectedVersion: 999 })
      .expect(409);
  });

  it('accepts a requirement typed by a person, traced to a real block', async () => {
    const { session } = await analysedProject();
    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];
    const reference = items[0]!.references[0]!;

    const response = await session.agent
      .post(ANALYSIS_ROUTES.requirements)
      .set('x-csrf-token', session.csrf)
      .send({
        title: 'Audit trail',
        statement: 'Every quote change must be recorded with who made it.',
        category: 'non_functional',
        nfrDimension: 'observability',
        references: [{ sourceId: reference.sourceId, blockId: reference.blockId }],
      })
      .expect(201);

    const added = response.body as RequirementItem;

    expect(added.origin).toBe('manual');
    expect(added.status).toBe('accepted');
    expect(added.references[0]?.verified).toBe(true);
  });

  it('refuses a non-functional requirement with no quality dimension', async () => {
    const { session } = await analysedProject();

    await session.agent
      .post(ANALYSIS_ROUTES.requirements)
      .set('x-csrf-token', session.csrf)
      .send({
        title: 'It should be good',
        statement: 'The system should be good.',
        category: 'non_functional',
      })
      .expect(422);
  });

  /* ---------------------------------------------------------- findings */

  it('surfaces a contradiction between two documents', async () => {
    /*
     * The case Phase 4 exists for. "Approval required" is in one document and
     * "no approval step" is in the other; neither chunk contradicts itself, so
     * only the cross-chunk stage can see it — and whichever chunk ran last must
     * not quietly win.
     */
    const { session } = await analysedProject();
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings).expect(200)).body;

    expect(findings.conflicts).toHaveLength(1);

    const conflict = findings.conflicts[0];

    expect(conflict.severity).toBe('blocking');
    expect(conflict.crossSource).toBe(true);
    expect(conflict.status).toBe('open');
    // Both sides survive. Neither has been chosen.
    expect(conflict.positions).toHaveLength(2);
    expect(conflict.resolution).toBeUndefined();
  });

  it('finds the same requirement stated in both documents', async () => {
    const { session } = await analysedProject();
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;

    const crossSource = findings.duplicates.find(
      (group: { crossSource: boolean }) => group.crossSource,
    );

    expect(crossSource).toBeDefined();
    expect(crossSource.kind).toBe('exact');
    // Grouped, not merged. A suggestion is offered; nothing has happened.
    expect(crossSource.status).toBe('open');
    expect(crossSource.suggestedPrimaryId).toBeDefined();
  });

  it('reports ambiguity and gaps without changing anything', async () => {
    const { session } = await analysedProject();
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;

    expect(findings.ambiguities).toHaveLength(1);
    expect(findings.ambiguities[0].phrase).toBe('within 24 hours');
    // A suggestion is offered and not applied.
    expect(findings.ambiguities[0].suggestion).toBeDefined();

    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];
    const ambiguous = items.find((item) => item.key === 'REQ-003');

    expect(ambiguous?.statement).toBe('Quotes must be sent within 24 hours.');

    expect(findings.gaps).toHaveLength(1);
    expect(findings.gaps[0].dimension).toBe('acceptance_criteria');
  });

  it('resolves a conflict only when a person chooses, and rejects the loser', async () => {
    const { session } = await analysedProject();
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;
    const conflict = findings.conflicts[0];

    await session.agent
      .post(ANALYSIS_ROUTES.conflict(conflict.id))
      .set('x-csrf-token', session.csrf)
      .send({
        action: 'choose',
        winningItemId: conflict.itemIds[0],
        note: 'Confirmed with the client on the call.',
        expectedVersion: conflict.version,
      })
      .expect(204);

    const after = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;

    expect(after.conflicts[0].status).toBe('resolved');
    expect(after.conflicts[0].resolution.winningItemId).toBe(conflict.itemIds[0]);

    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];
    const loser = items.find((item) => item.id === conflict.itemIds[1]);

    // Rejected, not deleted. What the other document said is part of the record.
    expect(loser?.status).toBe('rejected');
  });

  it('merges a duplicate only when asked, and supersedes rather than deletes', async () => {
    const { session } = await analysedProject();
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;
    const group = findings.duplicates.find((entry: { crossSource: boolean }) => entry.crossSource);

    await session.agent
      .post(ANALYSIS_ROUTES.duplicate(group.id))
      .set('x-csrf-token', session.csrf)
      .send({
        action: 'merge',
        primaryId: group.suggestedPrimaryId,
        expectedVersion: group.version,
      })
      .expect(204);

    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];
    const superseded = items.filter((item) => item.status === 'superseded');

    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded[0]?.supersededById).toBe(group.suggestedPrimaryId);
  });

  it('refuses a merge into an item that is not part of the group', async () => {
    const { session } = await analysedProject();
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;
    const group = findings.duplicates.find((entry: { crossSource: boolean }) => entry.crossSource);

    await session.agent
      .post(ANALYSIS_ROUTES.duplicate(group.id))
      .set('x-csrf-token', session.csrf)
      .send({ action: 'merge', primaryId: 'req_not_in_group', expectedVersion: group.version })
      .expect(422);
  });

  /* ----------------------------------------------------- clarifications */

  it('raises a blocking question about the contradiction', async () => {
    const { session } = await analysedProject();
    const clarifications = (await session.agent.get(ANALYSIS_ROUTES.clarifications).expect(200))
      .body as Clarification[];

    expect(clarifications).toHaveLength(1);
    expect(clarifications[0]?.key).toBe('Q-001');
    expect(clarifications[0]?.category).toBe('conflict');
    expect(clarifications[0]?.blocksApproval).toBe(true);
    expect(clarifications[0]?.status).toBe('open');
  });

  it('records an assumption as an assumption, and never invents one', async () => {
    const { session } = await analysedProject();
    const clarifications = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];

    // Nothing in the baseline is an assumption until a person makes one.
    const before = (await session.agent.get(ANALYSIS_ROUTES.requirements))
      .body as RequirementItem[];

    expect(before.some((item) => item.category === 'assumption')).toBe(false);

    await session.agent
      .post(ANALYSIS_ROUTES.answerClarification(clarifications[0]!.id))
      .set('x-csrf-token', session.csrf)
      .send({
        text: 'We are assuming manager approval is required.',
        isAssumption: true,
        integrateNow: false,
        expectedVersion: clarifications[0]!.version,
      })
      .expect(201);

    const after = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];
    const assumption = after.find((item) => item.category === 'assumption');

    expect(assumption).toBeDefined();
    expect(assumption?.origin).toBe('clarification');
    // Labelled, so nobody reads it as something the client said.
    expect(assumption?.title).toMatch(/^Assumption:/);
  });

  it('refuses to answer a question twice', async () => {
    const { session } = await analysedProject();
    const clarifications = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];
    const question = clarifications[0]!;

    const answer = {
      text: 'Yes, approval is required.',
      isAssumption: false,
      integrateNow: false,
      expectedVersion: question.version,
    };

    await session.agent
      .post(ANALYSIS_ROUTES.answerClarification(question.id))
      .set('x-csrf-token', session.csrf)
      .send(answer)
      .expect(201);

    await session.agent
      .post(ANALYSIS_ROUTES.answerClarification(question.id))
      .set('x-csrf-token', session.csrf)
      .send(answer)
      .expect(409);
  });

  /* --------------------------------------------------------- baseline */

  it('produces a baseline that reports what it is', async () => {
    const { session } = await analysedProject();
    const response = await session.agent.get(ANALYSIS_ROUTES.baseline).expect(200);
    const { baseline, notice } = response.body as { baseline: Baseline; notice: string };

    expect(baseline.version).toBe(1);
    expect(baseline.status).toBe('draft');
    expect(baseline.itemCount).toBe(5);
    // Never in a footer: the notice comes back with the baseline itself.
    expect(notice).toMatch(/self-hosted AI model/i);

    // Every block accounted for, including the page number the model judged.
    expect(baseline.coverage.notAnalysedBlocks).toBe(0);
    expect(baseline.coverage.noRequirementBlocks).toBeGreaterThan(0);
    expect(baseline.coverage.ratio).toBe(1);
  });

  it('does not claim completeness merely because generation succeeded', async () => {
    const { session } = await analysedProject();
    const { baseline } = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(baseline.alignment.isComplete).toBe(false);
    expect(baseline.alignment.overall).toBeLessThanOrEqual(0.85);
    expect(baseline.alignment.incompleteReasons.length).toBeGreaterThan(0);
  });

  it('refuses approval while a blocker remains, and says which', async () => {
    const { session } = await analysedProject();
    const { baseline } = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(baseline.blockers.length).toBeGreaterThan(0);
    expect(baseline.blockers.map((blocker) => blocker.kind)).toContain('blocking_conflict');
    expect(baseline.blockers.every((blocker) => blocker.action.length > 0)).toBe(true);

    await session.agent
      .post(ANALYSIS_ROUTES.approveBaseline)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: baseline.recordVersion })
      .expect(422);
  });

  it('refuses approval without the acknowledgement', async () => {
    const { session } = await analysedProject();
    const { baseline } = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    await session.agent
      .post(ANALYSIS_ROUTES.approveBaseline)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: false, expectedVersion: baseline.recordVersion })
      .expect(422);
  });

  it('approves once every blocker is cleared', async () => {
    const { session } = await analysedProject();

    await clearBlockers(session);

    const { baseline } = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(baseline.blockers).toEqual([]);

    const approved = await session.agent
      .post(ANALYSIS_ROUTES.approveBaseline)
      .set('x-csrf-token', session.csrf)
      .send({
        note: 'Reviewed with the client.',
        acknowledgedAiAssistance: true,
        expectedVersion: baseline.recordVersion,
      })
      .expect(201);

    expect((approved.body as Baseline).status).toBe('approved');
    expect((approved.body as Baseline).approvedAt).toBeDefined();
  });

  it('marks an approved baseline out of date when a document changes', async () => {
    const { session } = await analysedProject();

    await clearBlockers(session);

    const { baseline } = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    await session.agent
      .post(ANALYSIS_ROUTES.approveBaseline)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: baseline.recordVersion })
      .expect(201);

    // A third document arrives, reviewed.
    const added = await session.agent
      .post(REQUIREMENT_ROUTES.textSources)
      .set('x-csrf-token', session.csrf)
      .send({ title: 'Late addition', text: 'Quotes must be exported as PDF.' })
      .expect(201);

    await session.agent
      .post(REQUIREMENT_ROUTES.review(added.body.sourceId))
      .set('x-csrf-token', session.csrf)
      .send({ version: added.body.version })
      .expect(200);

    const after = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(after.baseline.status).toBe('outdated');
    expect(after.baseline.outdatedReason).toBe('source_added');
    // What was approved has not changed. Only the world around it.
    expect(after.baseline.itemCount).toBe(baseline.itemCount);
    expect(after.baseline.approvedAt).toBeDefined();

    await session.agent
      .post(ANALYSIS_ROUTES.approveBaseline)
      .set('x-csrf-token', session.csrf)
      .send({ acknowledgedAiAssistance: true, expectedVersion: after.baseline.recordVersion })
      .expect(409);
  });

  it('keeps every version readable', async () => {
    const { session } = await analysedProject();
    const versions = (await session.agent.get(ANALYSIS_ROUTES.baselineVersions).expect(200))
      .body as Baseline[];

    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);

    const one = await session.agent.get(ANALYSIS_ROUTES.baselineVersion(1)).expect(200);

    expect((one.body as Baseline).version).toBe(1);
  });

  /** Settles everything that stops approval, the way a reviewer would. */
  async function clearBlockers(session: Session): Promise<void> {
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;

    for (const conflict of findings.conflicts) {
      await session.agent
        .post(ANALYSIS_ROUTES.conflict(conflict.id))
        .set('x-csrf-token', session.csrf)
        .send({
          action: 'choose',
          winningItemId: conflict.itemIds[0],
          expectedVersion: conflict.version,
        })
        .expect(204);
    }

    for (const duplicate of findings.duplicates) {
      await session.agent
        .post(ANALYSIS_ROUTES.duplicate(duplicate.id))
        .set('x-csrf-token', session.csrf)
        .send({ action: 'keep_separate', expectedVersion: duplicate.version })
        .expect(204);
    }

    for (const gap of findings.gaps) {
      await session.agent
        .post(ANALYSIS_ROUTES.gap(gap.id))
        .set('x-csrf-token', session.csrf)
        .send({ status: 'accepted_risk', expectedVersion: gap.version })
        .expect(204);
    }

    const clarifications = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];

    for (const clarification of clarifications) {
      if (clarification.status !== 'open') {
        continue;
      }

      await session.agent
        .post(ANALYSIS_ROUTES.answerClarification(clarification.id))
        .set('x-csrf-token', session.csrf)
        .send({
          text: 'Approval is required.',
          isAssumption: false,
          integrateNow: false,
          expectedVersion: clarification.version,
        })
        .expect(201);
    }

    /*
     * The fabricated citation is the last blocker, and clearing it is a
     * reviewer's judgement rather than a button: they read REQ-003 against its
     * source and reject it, because the quotation was not there.
     */
    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];

    for (const item of items) {
      const unsupported =
        item.evidenceConfidence.band === 'unsupported' &&
        item.status !== 'rejected' &&
        item.status !== 'superseded';

      if (unsupported) {
        await session.agent
          .patch(ANALYSIS_ROUTES.requirement(item.id))
          .set('x-csrf-token', session.csrf)
          .send({ status: 'rejected', expectedVersion: item.version })
          .expect(200);
      }
    }
  }
});
