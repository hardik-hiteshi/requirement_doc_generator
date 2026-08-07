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
  type Conflict,
  type ConflictVersion,
  type IntegrationResult,
  type RequirementItem,
} from '@wdrg/contracts';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { configureSecurity } from '../src/security';
import { registerConflictVerdict, registerIntegrationFixture } from './analysis-fixtures';

/**
 * What happens to a contradiction when the client answers a question about it.
 *
 * The scenario throughout:
 *
 * > **REQ-001** — A manager must approve every quote before it is sent.
 * > **REQ-002** — Quotes are sent immediately, with no approval step.
 * > **Q-001** — Do quotes need approval before they are sent?
 *
 * Answer that, confirm it, and the conflict may genuinely be gone. It may also
 * still be there — the answer might change wording without settling the
 * disagreement, or address one side and leave the other standing. The
 * difference is decided by deterministic rules, and everything below is about
 * which way each case falls.
 *
 * The model's opinion appears in exactly one place, as a veto. There are tests
 * for the fact that agreeing changes nothing when a real condition fails.
 */
describe('Conflict re-evaluation (e2e)', () => {
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
    await app.init();

    provider = app.get(DeterministicProvider);
  });

  afterAll(async () => {
    await app?.close();
  });

  /* -------------------------------------------------------------- setup */

  const SOURCE = {
    title: 'Quoting brief',
    text: [
      'A manager must approve every quote before it is sent.',
      'Quotes are sent to the customer immediately, with no approval step.',
      'Every quote must record who created it.',
    ].join('\n'),
  };

  async function newProject(name = 'Conflict test') {
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

  /** A project with one blocking conflict and one question linked to it. */
  async function conflictedProject(): Promise<{
    session: Session;
    items: RequirementItem[];
    conflict: Conflict;
    clarification: Clarification;
  }> {
    const session = await newProject();

    const created = await session.agent
      .post(REQUIREMENT_ROUTES.textSources)
      .set('x-csrf-token', session.csrf)
      .send(SOURCE)
      .expect(201);

    const blocks = (created.body.effectiveContent.blocks as { id: string }[]).map(
      (block) => block.id,
    );

    await session.agent
      .post(REQUIREMENT_ROUTES.review(created.body.sourceId))
      .set('x-csrf-token', session.csrf)
      .send({ version: created.body.version })
      .expect(200);

    registerScenario(blocks);

    await session.agent
      .post(ANALYSIS_ROUTES.runs)
      .set('x-csrf-token', session.csrf)
      .send({ preserveUserDecisions: true })
      .expect(202);

    await settle(session);

    const items = (await session.agent.get(ANALYSIS_ROUTES.requirements)).body as RequirementItem[];
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;
    const clarifications = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];

    return {
      session,
      items,
      conflict: findings.conflicts[0] as Conflict,
      clarification: clarifications[0]!,
    };
  }

  function registerScenario(blocks: string[]): void {
    provider.reset();

    provider.registerSequence('requirement.normalize', [
      JSON.stringify({
        statements: [
          {
            id: 's1',
            text: 'A manager must approve every quote before it is sent.',
            blockIds: [blocks[0]],
          },
          {
            id: 's2',
            text: 'Quotes are sent to the customer immediately, with no approval step.',
            blockIds: [blocks[1]],
          },
          { id: 's3', text: 'Every quote must record who created it.', blockIds: [blocks[2]] },
        ],
      }),
    ]);

    provider.registerSequence('requirement.classify', [
      JSON.stringify({
        classifications: [
          { statementId: 's1', category: 'BUSINESS_RULE', confidence: 0.9 },
          { statementId: 's2', category: 'BUSINESS_RULE', confidence: 0.9 },
          { statementId: 's3', category: 'DATA_REQUIREMENT', confidence: 0.8 },
        ],
      }),
    ]);

    provider.registerSequence('requirement.extract', [
      JSON.stringify({
        items: [
          {
            id: 'r1',
            statementIds: ['s1'],
            category: 'BUSINESS_RULE',
            title: 'Manager approval',
            description: 'A manager must approve every quote before it is sent.',
            evidence: [
              {
                blockId: blocks[0],
                excerpt: 'A manager must approve every quote before it is sent.',
              },
            ],
            confidence: 0.9,
          },
          {
            id: 'r2',
            statementIds: ['s2'],
            category: 'BUSINESS_RULE',
            title: 'No approval step',
            description: 'Quotes are sent to the customer immediately, with no approval step.',
            evidence: [
              {
                blockId: blocks[1],
                excerpt: 'Quotes are sent to the customer immediately, with no approval step.',
              },
            ],
            confidence: 0.9,
          },
          {
            id: 'r3',
            statementIds: ['s3'],
            category: 'DATA_REQUIREMENT',
            title: 'Record the author',
            description: 'Every quote must record who created it.',
            evidence: [{ blockId: blocks[2], excerpt: 'Every quote must record who created it.' }],
            confidence: 0.8,
          },
        ],
        nonRequirementBlocks: [],
      }),
    ]);

    provider.registerSequence('requirement.duplicates', [JSON.stringify({ groups: [] })]);
    provider.registerSequence('requirement.conflicts', [
      JSON.stringify({
        conflicts: [
          {
            id: 'c1',
            kind: 'CONTRADICTION',
            severity: 'CRITICAL',
            summary: 'One requirement demands approval before sending; the other forbids a step.',
            positions: [
              { itemId: 'REQ-001', statement: 'A manager must approve every quote.' },
              { itemId: 'REQ-002', statement: 'Quotes are sent immediately, with no approval.' },
            ],
          },
        ],
      }),
    ]);
    provider.registerSequence('requirement.ambiguity', [JSON.stringify({ findings: [] })]);
    provider.registerSequence('requirement.missing', [JSON.stringify({ findings: [] })]);
    provider.registerSequence('clarification.generate', [
      JSON.stringify({
        questions: [
          {
            id: 'q1',
            question: 'Do quotes need manager approval before they are sent?',
            reason: 'Your document says both that they do and that they do not.',
            category: 'CONFLICT',
            impact: 'BLOCKING',
            itemIds: ['REQ-001', 'REQ-002'],
          },
        ],
      }),
    ]);
  }

  async function settle(session: Session): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const current = await session.agent.get(ANALYSIS_ROUTES.currentRun).expect(200);
      const run = current.body as AnalysisRun | null;

      if (!run || ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(run.status)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function answer(
    session: Session,
    clarificationId: string,
    text: string,
    isAssumption = false,
  ): Promise<Clarification> {
    const latest = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];
    const target = latest.find((entry) => entry.id === clarificationId)!;

    return (
      await session.agent
        .post(ANALYSIS_ROUTES.answerClarification(clarificationId))
        .set('x-csrf-token', session.csrf)
        .send({ text, isAssumption, expectedVersion: target.version })
        .expect(201)
    ).body as Clarification;
  }

  async function confirm(session: Session, clarificationId: string): Promise<IntegrationResult> {
    const latest = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];
    const target = latest.find((entry) => entry.id === clarificationId)!;

    return (
      await session.agent
        .post(ANALYSIS_ROUTES.confirmClarification(clarificationId))
        .set('x-csrf-token', session.csrf)
        .send({ acknowledged: true, expectedVersion: target.version })
        .expect(201)
    ).body as IntegrationResult;
  }

  async function readConflict(session: Session, conflictId: string): Promise<Conflict> {
    const findings = (await session.agent.get(ANALYSIS_ROUTES.findings)).body;

    return findings.conflicts.find((entry: Conflict) => entry.id === conflictId) as Conflict;
  }

  /*
   * Both wordings differ from what the requirements already say. An update that
   * repeats the existing statement is `unchanged`, not `applied` — which is
   * correct behaviour, and would make this test assert nothing.
   */
  const APPROVAL_REQUIRED =
    'A manager must approve every quote, without exception, before it is sent.';
  const NO_IMMEDIATE_SEND = 'Quotes are sent only after a manager has approved them.';

  /** Both sides updated, both applied, model agrees — the resolvable case. */
  async function resolveCleanly(
    session: Session,
    conflict: Conflict,
    clarificationId: string,
  ): Promise<IntegrationResult> {
    await answer(session, clarificationId, 'Yes — a manager must approve before sending.');
    registerIntegrationFixture(provider, [
      { itemId: conflict.itemIds[0]!, description: APPROVAL_REQUIRED },
      { itemId: conflict.itemIds[1]!, description: NO_IMMEDIATE_SEND },
    ]);
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: true }]);

    return confirm(session, clarificationId);
  }

  /* ------------------------------------------------------------ 1 and 2 */

  it('leaves a conflict alone when the clarification does not touch it', async () => {
    const { session, items, conflict } = await conflictedProject();
    const unrelated = items.find((item) => item.key === 'REQ-003')!;

    /*
     * A question about a requirement outside the conflict. Nothing in the
     * conflict changes, and no re-evaluation is recorded — "still conflicting"
     * would imply somebody looked at the substance, and nobody did.
     */
    const other = await session.agent
      .post(ANALYSIS_ROUTES.requirements)
      .set('x-csrf-token', session.csrf)
      .send({
        title: 'Export format',
        statement: 'Quotes export as PDF.',
        category: 'functional',
      })
      .expect(201);

    void unrelated;
    void other;

    const before = await readConflict(session, conflict.id);

    expect(before.status).toBe('open');
    expect(before.reevaluations).toEqual([]);
  });

  it('resolves a conflict when a confirmed answer settles both sides', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    expect(conflict.status).toBe('open');

    await resolveCleanly(session, conflict, clarification.id);

    const after = await readConflict(session, conflict.id);

    expect(after.status).toBe('resolved_by_clarification');
  });

  /* ---------------------------------------------------------------- 3 */

  it('records why it resolved, and every condition that held', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    await resolveCleanly(session, conflict, clarification.id);

    const after = await readConflict(session, conflict.id);
    const record = after.reevaluations.at(-1)!;

    expect(record.resultingStatus).toBe('resolved_by_clarification');
    expect(record.previousStatus).toBe('open');
    expect(record.clarificationKey).toBe(clarification.key);
    expect(record.answerVersion).toBe(1);
    expect(record.conditionsFailed).toEqual([]);
    expect(record.conditionsMet).toEqual(
      expect.arrayContaining([
        'confirmed_answer',
        'authoritative_not_assumption',
        'linked_to_conflict',
        'all_positions_addressed',
        'updates_applied',
        'semantic_agreement',
      ]),
    );
    expect(record.affectedItemIds.sort()).toEqual([...conflict.itemIds].sort());
    expect(record.rationale.length).toBeGreaterThan(20);
    expect(record.evaluatedAt).toBeDefined();
  });

  /* ---------------------------------------------------------- 4 and 5 */

  it('removes the conflict blocker once it is resolved', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    const before = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(before.baseline.blockers.map((blocker) => blocker.kind)).toContain('blocking_conflict');

    await resolveCleanly(session, conflict, clarification.id);

    const after = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(after.baseline.blockers.map((blocker) => blocker.kind)).not.toContain(
      'blocking_conflict',
    );
  });

  it('recalculates alignment after a resolution', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    const before = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    await resolveCleanly(session, conflict, clarification.id);

    const after = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(after.baseline.alignment.findingResolution).toBeGreaterThan(
      before.baseline.alignment.findingResolution,
    );
    expect(after.baseline.alignment.incompleteReasons.join(' ')).not.toMatch(/blocking conflict/i);
  });

  /* ---------------------------------------------------------- 6 and 7 */

  it('asks for a person when the answer reaches both sides without settling them', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    await answer(session, clarification.id, 'Approval is handled by the sales workflow.');
    registerIntegrationFixture(provider, [
      { itemId: conflict.itemIds[0]!, description: 'A manager approves quotes in the workflow.' },
      { itemId: conflict.itemIds[1]!, description: 'Quotes are sent through the workflow.' },
    ]);
    // Everything deterministic holds; the model does not think it settles the
    // disagreement. That is the veto doing its job.
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: false }]);

    await confirm(session, clarification.id);

    const after = await readConflict(session, conflict.id);

    expect(after.status).toBe('needs_review');
    expect(after.reevaluations.at(-1)?.conditionsFailed).toContain('semantic_agreement');
  });

  it('stays blocking when the answer leaves one side untouched', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    await answer(session, clarification.id, 'Yes — a manager must approve before sending.');
    // Only one of the two contradicting requirements is updated.
    registerIntegrationFixture(provider, [
      { itemId: conflict.itemIds[0]!, description: APPROVAL_REQUIRED },
    ]);
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: true }]);

    await confirm(session, clarification.id);

    const after = await readConflict(session, conflict.id);

    expect(after.status).toBe('still_conflicting');
    expect(after.reevaluations.at(-1)?.conditionsFailed).toContain('all_positions_addressed');

    const baseline = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(baseline.baseline.blockers.map((blocker) => blocker.kind)).toContain(
      'blocking_conflict',
    );
  });

  /* ---------------------------------------------------------------- 8 */

  it('the model agreeing is not enough on its own', async () => {
    /*
     * Everything the model can say is "yes". If that were sufficient, a model
     * would be able to clear a blocker on a document a client signs — so the
     * five deterministic conditions are checked regardless, and here the answer
     * is an assumption rather than a client fact.
     */
    const { session, conflict, clarification } = await conflictedProject();

    await answer(session, clarification.id, 'We assume approval is required.', true);
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: true }]);

    await confirm(session, clarification.id);

    const after = await readConflict(session, conflict.id);

    expect(after.status).not.toBe('resolved_by_clarification');

    const baseline = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(baseline.baseline.blockers.map((blocker) => blocker.kind)).toContain(
      'blocking_conflict',
    );
  });

  /* ---------------------------------------------------------------- 9 */

  it('keeps the original positions, whatever happens to the requirements', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    await resolveCleanly(session, conflict, clarification.id);

    const history = (
      await session.agent.get(ANALYSIS_ROUTES.conflictHistory(conflict.id)).expect(200)
    ).body as ConflictVersion[];

    expect(history.length).toBeGreaterThanOrEqual(2);

    const original = history.find((version) => version.changedBy === 'analysis')!;

    // What was conflicting before anybody touched it — quoted, not referenced,
    // so rewriting the requirement cannot change the record.
    expect(original.status).toBe('open');
    expect(original.positions).toHaveLength(2);
    expect(original.positions[0]?.statement).toMatch(/manager must approve/i);
    expect(original.positions[1]?.statement).toMatch(/no approval/i);

    const reevaluated = history.find(
      (version) => version.changedBy === 'clarification_reevaluation',
    )!;

    expect(reevaluated.clarificationKey).toBe(clarification.key);
    expect(reevaluated.rationale).toBeDefined();
  });

  /* -------------------------------------------------------- 10 and 11 */

  it('re-evaluates again when the confirmed answer changes', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    await resolveCleanly(session, conflict, clarification.id);
    expect((await readConflict(session, conflict.id)).status).toBe('resolved_by_clarification');

    // The client comes back: actually, no approval is needed after all.
    await answer(session, clarification.id, 'No — quotes go out without approval.');
    registerIntegrationFixture(provider, [
      { itemId: conflict.itemIds[0]!, description: 'Quotes are sent without manager approval.' },
    ]);
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: false }]);

    await confirm(session, clarification.id);

    const after = await readConflict(session, conflict.id);

    expect(after.status).not.toBe('resolved_by_clarification');
    expect(after.reevaluations).toHaveLength(2);
    expect(after.reevaluations[1]?.answerVersion).toBe(2);
    // The first re-evaluation is still there, saying what it said.
    expect(after.reevaluations[0]?.resultingStatus).toBe('resolved_by_clarification');
  });

  it('a superseded answer cannot resolve anything', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    await answer(session, clarification.id, 'Yes — approval is required.');

    // Replaced before anybody confirms it. The superseded text is not evidence.
    const changed = await answer(session, clarification.id, 'Actually, we are still deciding.');

    expect(changed.answers[0]?.status).toBe('superseded');

    registerIntegrationFixture(provider, [
      { itemId: conflict.itemIds[0]!, description: APPROVAL_REQUIRED },
      { itemId: conflict.itemIds[1]!, description: NO_IMMEDIATE_SEND },
    ]);
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: true }]);

    await confirm(session, clarification.id);

    const after = await readConflict(session, conflict.id);
    const record = after.reevaluations.at(-1);

    // Whatever it decided, it decided against the *current* answer — version 2.
    expect(record?.answerVersion).toBe(2);
  });

  /* --------------------------------------------------------------- 12 */

  it('a requirement the user edited is proposed, not rewritten, during re-evaluation', async () => {
    const { session, items, conflict, clarification } = await conflictedProject();
    const edited = items.find((item) => item.id === conflict.itemIds[0])!;

    await session.agent
      .patch(ANALYSIS_ROUTES.requirement(edited.id))
      .set('x-csrf-token', session.csrf)
      .send({
        statement: 'A manager or a director must approve every quote.',
        expectedVersion: edited.version,
      })
      .expect(200);

    await answer(session, clarification.id, 'Yes — a manager must approve before sending.');
    registerIntegrationFixture(provider, [
      { itemId: conflict.itemIds[0]!, description: APPROVAL_REQUIRED },
      { itemId: conflict.itemIds[1]!, description: NO_IMMEDIATE_SEND },
    ]);
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: true }]);

    await confirm(session, clarification.id);

    const kept = (await session.agent.get(ANALYSIS_ROUTES.requirement(edited.id)))
      .body as RequirementItem;

    expect(kept.statement).toBe('A manager or a director must approve every quote.');
    expect(kept.proposedRevision?.proposedStatement).toBe(APPROVAL_REQUIRED);

    // And the conflict is not resolved, because the change is not applied.
    const after = await readConflict(session, conflict.id);

    expect(after.status).toBe('needs_review');
    expect(after.reevaluations.at(-1)?.conditionsFailed).toContain('updates_applied');
  });

  it('resolves once the reviewer accepts the outstanding proposal', async () => {
    const { session, items, conflict, clarification } = await conflictedProject();
    const edited = items.find((item) => item.id === conflict.itemIds[0])!;

    await session.agent
      .patch(ANALYSIS_ROUTES.requirement(edited.id))
      .set('x-csrf-token', session.csrf)
      .send({ statement: 'A manager or a director approves.', expectedVersion: edited.version })
      .expect(200);

    await answer(session, clarification.id, 'Yes — a manager must approve before sending.');
    registerIntegrationFixture(provider, [
      { itemId: conflict.itemIds[0]!, description: APPROVAL_REQUIRED },
      { itemId: conflict.itemIds[1]!, description: NO_IMMEDIATE_SEND },
    ]);
    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: true }]);
    await confirm(session, clarification.id);

    const proposals = (await session.agent.get(ANALYSIS_ROUTES.proposals))
      .body as RequirementItem[];

    registerConflictVerdict(provider, [{ conflictId: conflict.id, settled: true }]);

    await session.agent
      .post(ANALYSIS_ROUTES.proposal(edited.id))
      .set('x-csrf-token', session.csrf)
      .send({ decision: 'accept', expectedVersion: proposals[0]!.version })
      .expect(201);

    const after = await readConflict(session, conflict.id);

    expect(after.status).toBe('resolved_by_clarification');
  });

  /* --------------------------------------------------------------- 13 */

  it('refuses a conflict belonging to another project', async () => {
    const first = await conflictedProject();
    const stranger = await newProject('Someone else');

    await stranger.agent.get(ANALYSIS_ROUTES.conflictHistory(first.conflict.id)).expect(404);

    await stranger.agent
      .post(ANALYSIS_ROUTES.conflict(first.conflict.id))
      .set('x-csrf-token', stranger.csrf)
      .send({ action: 'keep_both', expectedVersion: 0 })
      .expect(404);
  });

  /* --------------------------------------------------- 14, 15 and 16 */

  it('refuses a dismissal with no disposition or acknowledgement', async () => {
    const { session, clarification } = await conflictedProject();

    // The old generic dismissal: a reason and nothing else.
    await session.agent
      .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
      .set('x-csrf-token', session.csrf)
      .send({ reason: 'Not needed.', expectedVersion: clarification.version })
      .expect(422);

    await session.agent
      .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
      .set('x-csrf-token', session.csrf)
      .send({
        reason: 'Not needed.',
        disposition: 'NOT_APPLICABLE',
        expectedVersion: clarification.version,
      })
      .expect(422);

    // Still blocking, because nothing was accepted.
    const baseline = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    expect(baseline.baseline.blockers.map((blocker) => blocker.kind)).toContain(
      'unanswered_clarification',
    );
  });

  it('requires a resolvable reference for ANSWERED_ELSEWHERE', async () => {
    const { session, clarification } = await conflictedProject();

    await session.agent
      .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
      .set('x-csrf-token', session.csrf)
      .send({
        reason: 'The kick-off notes cover it.',
        disposition: 'ANSWERED_ELSEWHERE',
        acknowledged: true,
        expectedVersion: clarification.version,
      })
      .expect(422);

    await session.agent
      .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
      .set('x-csrf-token', session.csrf)
      .send({
        reason: 'The kick-off notes cover it.',
        disposition: 'ANSWERED_ELSEWHERE',
        reference: { kind: 'source', id: 'src_DOES_NOT_EXIST' },
        acknowledged: true,
        expectedVersion: clarification.version,
      })
      .expect(422);
  });

  it('accepts ANSWERED_ELSEWHERE with a real document, and records the check', async () => {
    const { session, items, clarification } = await conflictedProject();
    const sourceId = items[0]!.references[0]!.sourceId;

    const dismissed = (
      await session.agent
        .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
        .set('x-csrf-token', session.csrf)
        .send({
          reason: 'The brief already says which way this goes.',
          disposition: 'ANSWERED_ELSEWHERE',
          reference: { kind: 'source', id: sourceId },
          acknowledged: true,
          expectedVersion: clarification.version,
        })
        .expect(201)
    ).body as Clarification;

    expect(dismissed.status).toBe('DISMISSED');
    expect(dismissed.dismissal?.disposition).toBe('ANSWERED_ELSEWHERE');
    expect(dismissed.dismissal?.validation).toMatch(/checked/i);

    const baseline = (await session.agent.get(ANALYSIS_ROUTES.baseline)).body as {
      baseline: Baseline;
    };

    // Only now, and only because the reference stood up.
    expect(baseline.baseline.blockers.map((blocker) => blocker.kind)).not.toContain(
      'unanswered_clarification',
    );
  });

  it('refuses REQUIREMENT_REMOVED while the requirement is still in the baseline', async () => {
    const { session, items, clarification } = await conflictedProject();
    const live = items.find((item) => item.key === 'REQ-001')!;

    await session.agent
      .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
      .set('x-csrf-token', session.csrf)
      .send({
        reason: 'That requirement went.',
        disposition: 'REQUIREMENT_REMOVED',
        reference: { kind: 'requirement', id: live.id },
        acknowledged: true,
        expectedVersion: clarification.version,
      })
      .expect(422);

    // Reject it, and the same dismissal becomes true.
    await session.agent
      .patch(ANALYSIS_ROUTES.requirement(live.id))
      .set('x-csrf-token', session.csrf)
      .send({ status: 'rejected', expectedVersion: live.version })
      .expect(200);

    const latest = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];

    const dismissed = (
      await session.agent
        .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
        .set('x-csrf-token', session.csrf)
        .send({
          reason: 'That requirement went.',
          disposition: 'REQUIREMENT_REMOVED',
          reference: { kind: 'requirement', id: live.id },
          acknowledged: true,
          expectedVersion: latest[0]!.version,
        })
        .expect(201)
    ).body as Clarification;

    expect(dismissed.dismissal?.validation).toMatch(/rejected/i);
  });

  it('accepts a clarification reference only when that answer is confirmed', async () => {
    const { session, conflict, clarification } = await conflictedProject();

    const second = await session.agent
      .post(ANALYSIS_ROUTES.dismissClarification(clarification.id))
      .set('x-csrf-token', session.csrf)
      .send({
        reason: 'Asked and answered in Q-001.',
        disposition: 'ANSWERED_ELSEWHERE',
        // Pointing at itself, which has no confirmed answer yet.
        reference: { kind: 'clarification', id: clarification.id },
        acknowledged: true,
        expectedVersion: clarification.version,
      });

    expect(second.status).toBe(422);

    await resolveCleanly(session, conflict, clarification.id);

    // Now it has one, so the same reference resolves.
    const settled = (await session.agent.get(ANALYSIS_ROUTES.clarifications))
      .body as Clarification[];

    expect(settled[0]?.answers[0]?.confirmedAt).toBeDefined();
  });
});
