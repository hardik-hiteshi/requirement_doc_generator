import {
  UNDERSTANDING_SECTIONS,
  type ClientDependency,
  type EstimateUnit,
  type RequirementItem,
  type WorkPackage,
} from '@wdrg/contracts';

import { ClientDependencyComposer } from './composers/client-dependency.composer';
import { FeatureListingComposer } from './composers/feature-listing.composer';
import { UnderstandingComposer } from './composers/understanding.composer';
import { WorkBreakdownComposer } from './composers/work-breakdown.composer';
import type { UpstreamContext, UpstreamPlan } from './composers/composer.types';

/**
 * The composers, without a database.
 *
 * They are pure: an upstream state in, content and findings out. That is what
 * makes the interesting cases cheap to test here rather than through three
 * approvals and an HTTP round trip — and it is why `compose` takes no provider.
 */

function requirement(overrides: Partial<RequirementItem> = {}): RequirementItem {
  return {
    id: 'req_1',
    projectId: 'prj_1',
    runId: 'run_1',
    key: 'REQ-001',
    title: 'Record a timesheet',
    statement: 'Staff must record their weekly timesheets.',
    category: 'functional',
    priority: 'must',
    references: [
      {
        kind: 'document',
        sourceId: 'src_1',
        blockId: 'b1',
        excerpt: 'Staff must record their weekly timesheets.',
        reference: { kind: 'line', lineNumber: 4 },
        verified: true,
      },
    ],
    evidenceConfidence: { score: 0.9, band: 'high', drivers: [] },
    origin: 'ai',
    status: 'accepted',
    editedByUser: false,
    chunkIds: ['c1'],
    needsRevalidation: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    version: 0,
    ...overrides,
  } as RequirementItem;
}

function unit(overrides: Partial<EstimateUnit> = {}): EstimateUnit {
  return {
    id: 'eu_1',
    key: 'EST-001',
    requirementIds: ['req_1'],
    module: 'Timesheets',
    submodule: '',
    feature: 'Record a timesheet',
    taskCategory: 'crud',
    complexity: 'MEDIUM',
    complexityDrivers: [],
    complexityExplanation: '',
    uncertainty: 'LOW',
    uncertaintySources: [],
    uncertaintyExplanation: '',
    effort: { BACKEND: 8, FRONTEND: 6, QA: 4 },
    totalHours: 18,
    range: { optimistic: 15, expected: 18, conservative: 24 },
    drivers: [],
    rationale: '',
    source: 'CALCULATED',
    excluded: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    version: 0,
    ...overrides,
  } as EstimateUnit;
}

function context(overrides: Partial<UpstreamContext> = {}): UpstreamContext {
  const requirements = overrides.requirements ?? [requirement()];

  return {
    projectId: 'prj_1',
    projectName: 'Northwind',
    projectTypes: ['WEB_APPLICATION'],
    baseline: { id: 'bsl_1', version: 1, status: 'approved', itemIds: ['req_1'] },
    requirements,
    allRequirements: overrides.allRequirements ?? requirements,
    clarifications: [],
    openClarifications: [],
    stack: {
      id: 'stk_1',
      version: 1,
      status: 'LOCKED',
      components: [
        { category: 'backend', technologyId: 'nestjs', technologyName: 'NestJS', status: 'LOCKED' },
      ],
    },
    estimate: { id: 'esp_1', version: 1, status: 'APPROVED' },
    estimateUnits: [unit()],
    upstreamBlockers: [],
    timeline: { basis: 'RELATIVE', workingWeeks: 4, acknowledgedRisk: false },
    plan: null,
    /* No approved documents by default: each suite fills in what it needs. */
    documents: {
      understanding: null,
      featureListing: null,
      acceptanceCriteria: null,
      assumptions: null,
      statementOfWork: null,
      workBreakdown: null,
      clientDependencies: null,
    },
    ...overrides,
  };
}

describe('UnderstandingComposer', () => {
  const composer = new UnderstandingComposer();

  it('writes every template section, in order', () => {
    const { sections } = composer.compose(context());

    expect(sections).toHaveLength(UNDERSTANDING_SECTIONS.length);
    expect(sections.map((section) => section.order)).toEqual(
      UNDERSTANDING_SECTIONS.map((section) => section.order),
    );
  });

  /* The rule that keeps generated filler out of a client document. */
  it('leaves an unsupported section empty, with a reason', () => {
    const { sections } = composer.compose(context());
    const integrations = sections.find((section) => section.key === 'integrations')!;

    expect(integrations.body).toBe('');
    expect(integrations.omittedReason).toBeTruthy();
    expect(integrations.references).toEqual([]);
  });

  /*
   * The citation is a reference, not a string in the prose. A client-facing copy of
   * this document must not carry our identifiers, so the id lives here and the body
   * reads as a sentence.
   */
  it('records the requirement as a citation and keeps it out of the prose', () => {
    const { sections } = composer.compose(context());
    const scope = sections.find((section) => section.key === 'functional-scope')!;

    expect(scope.body).toContain('Staff must record their weekly timesheets.');
    expect(scope.body).not.toContain('REQ-001');
    expect(scope.references[0]).toMatchObject({
      kind: 'REQUIREMENT',
      id: 'REQ-001',
      sourceId: 'src_1',
      lineNumber: 4,
    });
  });

  it('invents no source location when the requirement has none', () => {
    const { sections } = composer.compose(
      context({ requirements: [requirement({ references: [] })] }),
    );
    const scope = sections.find((section) => section.key === 'functional-scope')!;

    expect(scope.references[0]?.pageNumber).toBeUndefined();
    expect(scope.references[0]?.lineNumber).toBeUndefined();
    expect(scope.references[0]?.sourceId).toBeUndefined();
  });

  it('is answerable for every approved requirement', () => {
    expect(composer.applicableRequirementIds(context())).toEqual(['REQ-001']);
  });

  describe('validation', () => {
    /**
     * A section as the engine passes it: the prose, plus the citations the
     * application recorded for it. Defaulted from any ids in the body, so a test
     * that writes `REQ-001` in the text gets the citation too.
     */
    const section = (key: string, body: string, references?: string[]) => ({
      key,
      body,
      references: references ?? [...body.matchAll(/\bREQ-\d{3,5}\b/g)].map((match) => match[0]),
    });

    const validate = (
      sections: { key: string; body: string; references: readonly string[] }[],
      overrides: Partial<UpstreamContext> = {},
      baselineCurrent = true,
    ) =>
      composer.validate({
        context: context(overrides),
        sections,
        features: [],
        rows: [],
        excludedRequirementIds: [],
        baselineCurrent,
      });

    it('passes a document that cites only approved requirements', () => {
      const findings = validate([
        section('project-overview', 'A timesheet system.'),
        section('functional-scope', 'REQ-001: Staff must record their weekly timesheets.'),
      ]);

      expect(findings.filter((finding) => finding.severity === 'BLOCKING')).toEqual([]);
      expect(findings.find((finding) => finding.kind === 'requirement_uncovered')?.severity).toBe(
        'PASS',
      );
    });

    it('blocks a citation to a requirement that does not exist', () => {
      const findings = validate([
        section('project-overview', 'A timesheet system.'),
        section('functional-scope', 'REQ-999: Something nobody asked for.'),
      ]);

      expect(
        findings.some(
          (finding) => finding.kind === 'unknown_requirement' && finding.severity === 'BLOCKING',
        ),
      ).toBe(true);
    });

    it('blocks a rejected requirement appearing in the document', () => {
      const rejected = requirement({ id: 'req_2', key: 'REQ-002', status: 'rejected' });

      const findings = validate(
        [
          section('project-overview', 'A timesheet system.'),
          section('functional-scope', 'REQ-001 and REQ-002.'),
        ],
        { allRequirements: [requirement(), rejected] },
      );

      expect(
        findings.some(
          (finding) =>
            finding.kind === 'rejected_requirement_present' && finding.severity === 'BLOCKING',
        ),
      ).toBe(true);
    });

    it('blocks a stale baseline', () => {
      const findings = validate(
        [
          section('project-overview', 'A timesheet system.'),
          section('functional-scope', 'REQ-001.'),
        ],
        {},
        false,
      );

      expect(findings.some((finding) => finding.kind === 'stale_baseline')).toBe(true);
    });

    it.each([
      ['99.9% uptime', 'availability'],
      ['GDPR compliant', 'compliance'],
      ['10,000 concurrent users', 'user volume'],
      ['built with AI-assisted development', 'methodology'],
    ])('blocks an invented commitment: %s', (phrase) => {
      const findings = validate([
        section('project-overview', `A timesheet system that is ${phrase}.`),
        section('functional-scope', 'REQ-001.'),
      ]);

      expect(
        findings.some(
          (finding) => finding.kind === 'unsupported_statement' && finding.severity === 'BLOCKING',
        ),
      ).toBe(true);
    });

    it('blocks a requirement claimed as both in scope and out of scope', () => {
      const findings = validate([
        section('project-overview', 'A timesheet system.'),
        section('functional-scope', 'REQ-001 is included.'),
        section('out-of-scope', 'REQ-001 is not included.'),
      ]);

      expect(
        findings.some(
          (finding) => finding.kind === 'scope_contradiction' && finding.severity === 'BLOCKING',
        ),
      ).toBe(true);
    });

    it('blocks an empty required section', () => {
      const findings = validate([
        section('project-overview', '  '),
        section('functional-scope', 'REQ-001.'),
      ]);

      expect(
        findings.some(
          (finding) => finding.kind === 'empty_section' && finding.severity === 'BLOCKING',
        ),
      ).toBe(true);
    });

    it('warns when a requirement is nowhere in the document', () => {
      const findings = composer.validate({
        context: context({
          requirements: [requirement(), requirement({ id: 'req_2', key: 'REQ-002' })],
        }),
        sections: [
          section('project-overview', 'A timesheet system.'),
          section('functional-scope', 'REQ-001 only.'),
        ],
        features: [],
        rows: [],
        excludedRequirementIds: [],
        baselineCurrent: true,
      });

      const uncovered = findings.find((finding) => finding.kind === 'requirement_uncovered')!;

      expect(uncovered.severity).toBe('WARNING');
      expect(uncovered.subjectIds).toEqual(['REQ-002']);
    });
  });
});

describe('FeatureListingComposer', () => {
  const composer = new FeatureListingComposer();

  it('builds one row per estimate unit, with the estimate’s hours', () => {
    const { features } = composer.compose(context());

    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({
      requirementIds: ['REQ-001'],
      effort: { BACKEND: 8, FRONTEND: 6, QA: 4 },
      totalHours: 18,
      estimateUnitIds: ['eu_1'],
      reviewStatus: 'GENERATED',
    });
  });

  /* Overhead is not a feature a client is buying. */
  it('excludes overhead activities and excluded units', () => {
    const { features } = composer.compose(
      context({
        estimateUnits: [
          unit(),
          unit({ id: 'eu_2', overheadActivity: 'code_review' }),
          unit({ id: 'eu_3', excluded: true }),
        ],
      }),
    );

    expect(features.map((row) => row.estimateUnitIds[0])).toEqual(['eu_1']);
  });

  it('leaves the screen empty for a project with no interface', () => {
    const { features } = composer.compose(context({ projectTypes: ['BACKEND_API'] }));

    expect(features[0]?.screen).toBe('');
  });

  it('is answerable for functional requirements and business rules only', () => {
    const applicable = composer.applicableRequirementIds(
      context({
        requirements: [
          requirement(),
          requirement({ id: 'req_2', key: 'REQ-002', category: 'constraint' }),
          requirement({ id: 'req_3', key: 'REQ-003', category: 'business_rule' }),
        ],
      }),
    );

    expect(applicable).toEqual(['REQ-001', 'REQ-003']);
  });

  it('reconciles hours with the estimate, and blocks when they differ', () => {
    const composed = composer.compose(context());
    const rows = composed.features.map((row, index) => ({ ...row, featureId: `ftr_${index}` }));

    expect(composer.reconciliationFor(context(), rows).reconciles).toBe(true);

    /* A row citing a unit that is not in the estimate cannot reconcile. */
    const stray = [{ ...rows[0]!, estimateUnitIds: ['eu_ghost'] }];
    const reconciliation = composer.reconciliationFor(context(), stray);

    expect(reconciliation.reconciles).toBe(false);
    expect(reconciliation.unknownUnitIds).toEqual(['eu_ghost']);
  });

  it('blocks a listing that leaves a requirement undecided', () => {
    const two = context({
      requirements: [requirement(), requirement({ id: 'req_2', key: 'REQ-002' })],
    });

    const findings = composer.validate({
      context: two,
      sections: [],
      features: composer
        .compose(two)
        .features.map((row, index) => ({ ...row, featureId: `ftr_${index}` })),
      rows: [],
      excludedRequirementIds: [],
      baselineCurrent: true,
    });

    const coverage = findings.find((finding) => finding.kind === 'requirement_uncovered')!;

    expect(coverage.severity).toBe('BLOCKING');
    expect(coverage.subjectIds).toContain('REQ-002');
  });

  it('treats a deliberate exclusion as a decision, not a gap', () => {
    const two = context({
      requirements: [requirement(), requirement({ id: 'req_2', key: 'REQ-002' })],
    });

    const findings = composer.validate({
      context: two,
      sections: [],
      features: composer
        .compose(two)
        .features.map((row, index) => ({ ...row, featureId: `ftr_${index}` })),
      rows: [],
      excludedRequirementIds: ['REQ-002'],
      baselineCurrent: true,
    });

    expect(findings.find((finding) => finding.kind === 'requirement_uncovered')?.severity).toBe(
      'PASS',
    );
  });

  it('blocks a technology that is not in the locked stack', () => {
    const findings = composer.validate({
      context: context(),
      sections: [],
      features: [
        {
          ...composer.compose(context()).features[0]!,
          featureId: 'ftr_0',
          technologyIds: ['some-other-framework'],
        },
      ],
      rows: [],
      excludedRequirementIds: [],
      baselineCurrent: true,
    });

    expect(
      findings.some(
        (finding) =>
          finding.kind === 'unknown_technology_reference' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });
});

/* ==================================================== the work breakdown */

/**
 * The breakdown, against a plan.
 *
 * Every assertion here is about faithfulness rather than cleverness: the hours, the
 * days and the critical path all have to come out the other side unchanged, because
 * the document's whole claim is that it is the approved plan in a readable shape.
 */
function plan(overrides: Partial<UpstreamPlan> = {}): UpstreamPlan {
  return {
    effortByRole: { BACKEND: 8, FRONTEND: 6, QA: 4 },
    totalHours: 18,
    tasks: [
      {
        taskId: 'eu_1',
        startDay: 1,
        endDay: 3,
        durationDays: 3,
        role: 'BACKEND',
        hours: 18,
        predecessorIds: [],
        slackDays: 0,
        onCriticalPath: true,
      },
    ],
    milestones: [
      {
        id: 'ms_1',
        kind: 'module_complete',
        label: 'Timesheets complete',
        day: 3,
        taskIds: ['eu_1'],
        userDefined: false,
      },
    ],
    criticalPath: ['eu_1'],
    totalWorkingDays: 3,
    relativeOnly: true,
    ...overrides,
  };
}

describe('WorkBreakdownComposer', () => {
  const composer = new WorkBreakdownComposer();

  const packages = (ctx: UpstreamContext): readonly WorkPackage[] =>
    composer.compose(ctx).rows.map((row) => row.payload as WorkPackage);

  it('builds a hierarchy from the estimate’s own grouping', () => {
    const rows = packages(context({ plan: plan() }));

    expect(rows.map((row) => row.level)).toEqual(['PROJECT', 'PHASE', 'MODULE', 'FEATURE', 'TASK']);
    expect(rows.map((row) => row.wbsId)).toEqual(['1', '1.1', '1.1.1', '1.1.1.1', '1.1.1.1.1']);
  });

  it('omits the submodule tier when the estimate has no submodules', () => {
    /* A tier of empty containers reads as structure and is not. */
    expect(packages(context({ plan: plan() })).some((row) => row.level === 'SUBMODULE')).toBe(
      false,
    );
  });

  it('adds a submodule tier when the estimate has one', () => {
    const rows = packages(
      context({ plan: plan(), estimateUnits: [unit({ submodule: 'Weekly entry' })] }),
    );

    expect(rows.some((row) => row.level === 'SUBMODULE' && row.submodule === 'Weekly entry')).toBe(
      true,
    );
  });

  it('copies the approved hours onto the leaf, role by role', () => {
    const leaf = packages(context({ plan: plan() })).find((row) => row.level === 'TASK')!;

    expect(leaf.effort).toEqual({ BACKEND: 8, FRONTEND: 6, QA: 4 });
    expect(leaf.totalEffort).toBe(18);
  });

  it('copies the schedule and the critical path rather than deriving them', () => {
    const leaf = packages(context({ plan: plan() })).find((row) => row.level === 'TASK')!;

    expect(leaf.relativeStartDay).toBe(1);
    expect(leaf.relativeFinishDay).toBe(3);
    expect(leaf.workingDuration).toBe(3);
    expect(leaf.onCriticalPath).toBe(true);
    expect(leaf.parallelizable).toBe(false);
  });

  it('marks work the plan gave slack to as able to run in parallel', () => {
    const rows = packages(
      context({
        plan: plan({
          tasks: [
            {
              taskId: 'eu_1',
              startDay: 1,
              endDay: 3,
              durationDays: 3,
              role: 'BACKEND',
              hours: 18,
              predecessorIds: [],
              slackDays: 4,
              onCriticalPath: false,
            },
          ],
          criticalPath: [],
        }),
      }),
    );

    expect(rows.find((row) => row.level === 'TASK')!.parallelizable).toBe(true);
  });

  it('publishes working days and no dates when the project has no start date', () => {
    const rows = packages(context({ plan: plan() }));

    /* Turning day 3 into a Tuesday would invent the commencement. */
    expect(rows.every((row) => row.actualStartDate === undefined)).toBe(true);
    expect(rows.every((row) => row.actualFinishDate === undefined)).toBe(true);
  });

  it('publishes dates when the approved plan has them', () => {
    const rows = packages(
      context({
        plan: plan({
          relativeOnly: false,
          startDate: '2026-09-01',
          tasks: [
            {
              taskId: 'eu_1',
              startDay: 1,
              endDay: 3,
              durationDays: 3,
              role: 'BACKEND',
              hours: 18,
              predecessorIds: [],
              slackDays: 0,
              onCriticalPath: true,
              startDate: '2026-09-01',
              endDate: '2026-09-03',
            },
          ],
        }),
      }),
    );

    expect(rows.find((row) => row.level === 'TASK')!.actualStartDate).toBe('2026-09-01');
  });

  it('cites requirements by their key, not the estimate’s internal id', () => {
    /*
     * The translation that is invisible when it is wrong: every row would look fine
     * and every citation check would report an unknown requirement.
     */
    const leaf = packages(context({ plan: plan() })).find((row) => row.level === 'TASK')!;

    expect(leaf.requirementIds).toEqual(['REQ-001']);
  });

  it('rolls a container up from its children', () => {
    const rows = packages(
      context({
        plan: plan({
          effortByRole: { BACKEND: 16, FRONTEND: 12, QA: 8 },
          totalHours: 36,
          tasks: [
            {
              taskId: 'eu_1',
              startDay: 1,
              endDay: 3,
              durationDays: 3,
              role: 'BACKEND',
              hours: 18,
              predecessorIds: [],
              slackDays: 0,
              onCriticalPath: true,
            },
            {
              taskId: 'eu_2',
              startDay: 2,
              endDay: 5,
              durationDays: 4,
              role: 'BACKEND',
              hours: 18,
              predecessorIds: [],
              slackDays: 0,
              onCriticalPath: true,
            },
          ],
          criticalPath: ['eu_1', 'eu_2'],
          totalWorkingDays: 5,
        }),
        estimateUnits: [
          unit(),
          unit({ id: 'eu_2', key: 'EST-002', feature: 'Approve a timesheet' }),
        ],
      }),
    );

    const module = rows.find((row) => row.level === 'MODULE')!;

    expect(module.totalEffort).toBe(36);
    /* The span the work occupies, not the sum of its durations. */
    expect(module.relativeStartDay).toBe(1);
    expect(module.relativeFinishDay).toBe(5);
    expect(module.workingDuration).toBe(5);
  });

  it('separates project overhead from feature work', () => {
    const rows = packages(
      context({
        plan: plan({
          effortByRole: { BACKEND: 8, FRONTEND: 6, QA: 4, DEVOPS: 6 },
          tasks: [
            ...plan().tasks,
            {
              taskId: 'eu_ci',
              startDay: 1,
              endDay: 1,
              durationDays: 1,
              role: 'DEVOPS',
              hours: 6,
              predecessorIds: [],
              slackDays: 2,
              onCriticalPath: false,
            },
          ],
        }),
        estimateUnits: [
          unit(),
          unit({
            id: 'eu_ci',
            key: 'EST-002',
            feature: 'Pipeline',
            overheadActivity: 'ci_cd',
            effort: { DEVOPS: 6 },
            totalHours: 6,
            requirementIds: [],
          }),
        ],
      }),
    );

    /* Two days of CI work a client cannot see is two days that get cut. */
    expect(rows.some((row) => row.level === 'PHASE' && row.phase === 'Project overhead')).toBe(
      true,
    );
  });

  it('maps predecessors to WBS ids rather than leaving estimate ids on the sheet', () => {
    const rows = packages(
      context({
        plan: plan({
          effortByRole: { BACKEND: 16, FRONTEND: 12, QA: 8 },
          tasks: [
            ...plan().tasks,
            {
              taskId: 'eu_2',
              startDay: 4,
              endDay: 6,
              durationDays: 3,
              role: 'BACKEND',
              hours: 18,
              predecessorIds: ['eu_1'],
              slackDays: 0,
              onCriticalPath: true,
            },
          ],
          criticalPath: ['eu_1', 'eu_2'],
          totalWorkingDays: 6,
        }),
        estimateUnits: [
          unit(),
          unit({ id: 'eu_2', key: 'EST-002', feature: 'Approve a timesheet' }),
        ],
      }),
    );

    /* The leaf, not a rolled-up container — those list every unit beneath them. */
    const second = rows.find(
      (row) => row.level === 'TASK' && row.estimateUnitIds.includes('eu_2'),
    )!;

    expect(second.predecessors).toEqual(['1.1.1.1.1']);
    expect(second.dependencyType).toBe('FINISH_TO_START');
  });

  it('produces nothing at all without an approved plan', () => {
    expect(composer.compose(context({ plan: null })).rows).toEqual([]);
  });

  /* ------------------------------------------------------- validation */

  const validate = (ctx: UpstreamContext, rows: readonly WorkPackage[]) =>
    composer.validate({
      context: ctx,
      sections: [],
      features: [],
      rows: rows.map((payload, index) => ({
        rowId: `drw_${index}`,
        kind: 'WORK_PACKAGE' as const,
        order: index,
        origin: 'GENERATED' as const,
        references: [],
        payload,
        updatedAt: '2026-08-10T00:00:00.000Z',
      })),
      excludedRequirementIds: [],
      baselineCurrent: true,
    });

  it('passes reconciliation on its own output', () => {
    const ctx = context({ plan: plan() });
    const findings = validate(ctx, packages(ctx));

    expect(
      findings.some((finding) => finding.kind === 'effort_mismatch' && finding.severity === 'PASS'),
    ).toBe(true);
  });

  it('blocks when the hours no longer add up to the approved estimate', () => {
    const ctx = context({ plan: plan() });
    const rows = packages(ctx).map((row) =>
      row.level === 'TASK' ? { ...row, effort: { BACKEND: 40 }, totalEffort: 40 } : row,
    );

    const finding = validate(ctx, rows).find((entry) => entry.kind === 'effort_mismatch');

    expect(finding?.severity).toBe('BLOCKING');
  });

  it('blocks a task that claims the critical path when the plan gave it slack', () => {
    const ctx = context({ plan: plan({ criticalPath: [] }) });
    const rows = packages(ctx);

    expect(
      validate(ctx, rows).some(
        (finding) => finding.kind === 'critical_path_mismatch' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });

  it('blocks work scheduled past the end of the approved plan', () => {
    const ctx = context({ plan: plan() });
    const rows = packages(ctx).map((row) =>
      row.level === 'TASK' ? { ...row, relativeFinishDay: 40 } : row,
    );

    expect(
      validate(ctx, rows).some(
        (finding) => finding.kind === 'schedule_beyond_plan' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });

  it('blocks a calendar date on a project with no agreed start', () => {
    const ctx = context({ plan: plan() });
    const rows = packages(ctx).map((row) =>
      row.level === 'TASK' ? { ...row, actualStartDate: '2026-09-01' } : row,
    );

    expect(
      validate(ctx, rows).some(
        (finding) => finding.kind === 'invented_date' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });

  it('blocks a broken hierarchy', () => {
    const ctx = context({ plan: plan() });
    const rows = packages(ctx).map((row) =>
      row.level === 'TASK' ? { ...row, parentId: '9.9' } : row,
    );

    expect(
      validate(ctx, rows).some(
        (finding) => finding.kind === 'structure_invalid' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });

  it('says so plainly when there is no approved estimate', () => {
    const findings = validate(context({ plan: null }), []);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('estimate_missing');
  });
});

/* ============================================= the client dependency sheet */

/**
 * A credential-shaped string, assembled at runtime.
 *
 * A literal here would be flagged by every secret scanner that reads this repository
 * — including the one on the push path — for a string that is only ever fed to a
 * detector. Joined, the test sees the identical value.
 */
function stripeShaped(): string {
  return ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
}

describe('ClientDependencyComposer', () => {
  const composer = new ClientDependencyComposer();

  const integration = requirement({
    id: 'req_2',
    key: 'REQ-002',
    title: 'Payroll export',
    statement: 'Timesheet totals must be sent to Sage Payroll each month.',
    category: 'integration',
  });

  const dependencies = (ctx: UpstreamContext): readonly ClientDependency[] =>
    composer.compose(ctx).rows.map((row) => row.payload as ClientDependency);

  it('raises a documentation-and-access row for an approved integration', () => {
    const rows = dependencies(
      context({ plan: plan(), requirements: [requirement(), integration] }),
    );

    const row = rows.find((entry) => entry.category === 'API_DOCUMENTATION');

    expect(row).toBeDefined();
    expect(row!.requirementIds).toEqual(['REQ-002']);
    expect(row!.sourceKinds).toContain('REQUIREMENT_BASELINE');
    expect(row!.dependencyKey).toMatch(/^CD-\d{3}$/);
  });

  it('asks for an account for a third-party service in the locked stack', () => {
    const rows = dependencies(
      context({
        plan: plan(),
        stack: {
          id: 'stk_1',
          version: 1,
          status: 'LOCKED',
          components: [
            {
              category: 'payment',
              technologyId: 'stripe',
              technologyName: 'Stripe',
              status: 'LOCKED',
            },
          ],
        },
      }),
    );

    const row = rows.find((entry) => entry.category === 'CREDENTIALS');

    expect(row?.dependency).toContain('Stripe');
    expect(row?.credentialsRequired).toBe(true);
    expect(row?.sourceKinds).toContain('TECHNOLOGY_STACK');
  });

  it('does not ask the client for infrastructure a delivery team provisions', () => {
    /* Padding the sheet is how the real dependency gets missed among the fake ones. */
    const rows = dependencies(context({ plan: plan() }));

    expect(rows.some((entry) => entry.dependency.includes('NestJS'))).toBe(false);
  });

  it('turns an unanswered clarification into a dependency on the client', () => {
    const rows = dependencies(
      context({
        plan: plan(),
        openClarifications: [
          {
            id: 'clr_1',
            label: 'CLR-001',
            question: 'Which payroll periods should the export cover?',
            requirementIds: ['REQ-001'],
            blocking: true,
          },
        ],
      }),
    );

    const row = rows.find((entry) => entry.sourceKinds.includes('OPEN_CLARIFICATION'));

    expect(row?.priority).toBe('CRITICAL');
    expect(row?.dependency).toContain('payroll periods');
  });

  it('starts everything unrequested, with nobody named', () => {
    const rows = dependencies(
      context({ plan: plan(), requirements: [requirement(), integration] }),
    );

    for (const row of rows) {
      expect(row.status).toBe('NOT_REQUESTED');
      /* Naming the wrong person in a client-facing sheet is worse than naming nobody. */
      expect(row.clientOwner).toBe('');
      expect(row.internalOwner).toBe('');
    }
  });

  it('states timing relative to commencement when the plan has no dates', () => {
    const rows = dependencies(
      context({ plan: plan(), requirements: [requirement(), integration] }),
    );

    for (const row of rows) {
      expect(row.actualDueDate).toBeUndefined();
      expect(row.relativeDue.length).toBeGreaterThan(0);
    }
  });

  /* ------------------------------------------------------- validation */

  const validate = (ctx: UpstreamContext, rows: readonly ClientDependency[]) =>
    composer.validate({
      context: ctx,
      sections: [],
      features: [],
      rows: rows.map((payload, index) => ({
        rowId: `drw_${index}`,
        kind: 'CLIENT_DEPENDENCY' as const,
        order: index,
        origin: 'GENERATED' as const,
        references: [],
        payload,
        updatedAt: '2026-08-10T00:00:00.000Z',
      })),
      excludedRequirementIds: [],
      baselineCurrent: true,
    });

  it('passes the credential check on its own output', () => {
    const ctx = context({ plan: plan(), requirements: [requirement(), integration] });

    expect(
      validate(ctx, dependencies(ctx)).some(
        (finding) => finding.kind === 'credential_value_present' && finding.severity === 'PASS',
      ),
    ).toBe(true);
  });

  it('blocks a row that carries an actual credential', () => {
    const ctx = context({ plan: plan(), requirements: [requirement(), integration] });
    const rows = dependencies(ctx).map((row, index) =>
      index === 0 ? { ...row, remarks: `they sent ${stripeShaped()}` } : row,
    );

    expect(
      validate(ctx, rows).some(
        (finding) => finding.kind === 'credential_value_present' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });

  it('blocks a row nobody could action or close', () => {
    const ctx = context({ plan: plan(), requirements: [requirement(), integration] });
    const rows = dependencies(ctx).map((row, index) =>
      index === 0 ? { ...row, dependency: 'Client must provide all required information' } : row,
    );

    expect(
      validate(ctx, rows).some(
        (finding) => finding.kind === 'dependency_vague' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });

  it('blocks a row that is accepted with nothing recorded about the check', () => {
    const ctx = context({ plan: plan(), requirements: [requirement(), integration] });
    const rows = dependencies(ctx).map((row, index) =>
      index === 0 ? { ...row, status: 'ACCEPTED' as const, validationNote: '' } : row,
    );

    expect(
      validate(ctx, rows).some(
        (finding) =>
          finding.kind === 'dependency_status_invalid' && finding.severity === 'BLOCKING',
      ),
    ).toBe(true);
  });
});
