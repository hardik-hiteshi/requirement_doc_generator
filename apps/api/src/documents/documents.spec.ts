import { UNDERSTANDING_SECTIONS, type EstimateUnit, type RequirementItem } from '@wdrg/contracts';

import { FeatureListingComposer } from './composers/feature-listing.composer';
import { UnderstandingComposer } from './composers/understanding.composer';
import type { UpstreamContext } from './composers/composer.types';

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
    /* No approved documents by default: each suite fills in what it needs. */
    documents: {
      understanding: null,
      featureListing: null,
      acceptanceCriteria: null,
      assumptions: null,
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
