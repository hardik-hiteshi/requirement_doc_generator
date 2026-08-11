import { describe, expect, it } from 'vitest';

import {
  acceptanceCriterionSchema,
  calculateCriteriaCoverage,
  criterionFingerprint,
  criterionText,
  isGherkinShaped,
  nextCriterionKey,
  unstatedThresholds,
  type AcceptanceCriterion,
} from './acceptance-criteria.contract';
import {
  assumptionCandidateSchema,
  assumptionSchema,
  canTransitionAssumption,
  candidateToAssumption,
  contradictoryAssumptions,
  entersApprovedDocument,
  isAuthoritativeProvenance,
  nextAssumptionKey,
  summariseAssumptions,
  type Assumption,
} from './assumptions.contract';
import {
  documentRowSchema,
  isRowProtected,
  mayReplaceRowDirectly,
  rowNeedsAttribution,
  rowsAwaitingDecision,
} from './document-row.contract';
import {
  inventedDates,
  internalMethodologyTerms,
  isModelWritableSowSection,
  prohibitedLegalTerms,
  reconcileSowScope,
  sowSectionDraftSchema,
  staffingClaims,
  timelineStatement,
  unsupportedDeliverables,
  MODEL_WRITABLE_SOW_SECTIONS,
  REQUIRED_SOW_SECTION_KEYS,
  SOW_SECTIONS,
  type SowTimeline,
} from './statement-of-work.contract';

/* =================================================== the shared row envelope */

describe('the shared row envelope', () => {
  const row = {
    rowId: 'row_1',
    kind: 'ACCEPTANCE_CRITERION' as const,
    order: 0,
    origin: 'GENERATED' as const,
    references: [{ kind: 'REQUIREMENT' as const, id: 'REQ-001' }],
    payload: { then: 'The record is saved.' },
    updatedAt: '2026-08-11T00:00:00.000Z',
  };

  it('accepts a row and leaves the payload to the document', () => {
    expect(documentRowSchema.safeParse(row).success).toBe(true);
  });

  it('refuses a field nobody defined', () => {
    expect(documentRowSchema.safeParse({ ...row, sneaked: true }).success).toBe(false);
  });

  it('protects what a person wrote and not what was generated', () => {
    expect(isRowProtected('GENERATED')).toBe(false);
    expect(isRowProtected('USER_EDITED')).toBe(true);
    expect(isRowProtected('USER_DEFINED')).toBe(true);
    expect(mayReplaceRowDirectly('GENERATED')).toBe(true);
    expect(mayReplaceRowDirectly('USER_EDITED')).toBe(false);
  });

  /*
   * A row somebody typed in, citing nothing, with no note: an assertion that
   * cannot be checked. Approval waits for a sentence saying where it came from.
   */
  it('asks where a hand-written row came from when nothing else says', () => {
    expect(rowNeedsAttribution({ origin: 'USER_DEFINED', references: [], attribution: '' })).toBe(
      true,
    );
    expect(
      rowNeedsAttribution({
        origin: 'USER_DEFINED',
        references: [],
        attribution: 'Agreed on the call of 4 August.',
      }),
    ).toBe(false);
    /* Citing a requirement is itself an answer. */
    expect(
      rowNeedsAttribution({
        origin: 'USER_DEFINED',
        references: [{ kind: 'REQUIREMENT', id: 'REQ-001' }],
        attribution: '',
      }),
    ).toBe(false);
    /* A generated row is traceable by construction. */
    expect(rowNeedsAttribution({ origin: 'GENERATED', references: [], attribution: '' })).toBe(
      false,
    );
  });

  it('lists the rows waiting for a decision', () => {
    expect(
      rowsAwaitingDecision([
        { rowId: 'a', proposed: { then: 'Something else.' } },
        { rowId: 'b', proposed: undefined },
        { rowId: 'c', proposed: null },
      ]),
    ).toEqual(['a']);
  });
});

/* ==================================================== 3. Acceptance Criteria */

describe('an acceptance criterion', () => {
  const criterion: AcceptanceCriterion = {
    criterionKey: 'AC-001',
    requirementIds: ['REQ-001'],
    featureIds: ['ftr_1'],
    module: 'Timesheets',
    submodule: 'Entry',
    screen: 'Weekly grid',
    actor: 'Staff member',
    aspect: 'BEHAVIOUR',
    given: 'a staff member is signed in',
    when: 'they submit a completed weekly timesheet',
    then: 'the timesheet is recorded and shown as submitted',
    rule: 'A timesheet may only be submitted once per week.',
    requiresProcedure: false,
    status: 'DRAFT',
    notes: '',
  };

  it('accepts a well-formed criterion', () => {
    expect(acceptanceCriterionSchema.safeParse(criterion).success).toBe(true);
  });

  it('insists on a key that reads as one', () => {
    expect(acceptanceCriterionSchema.safeParse({ ...criterion, criterionKey: '1' }).success).toBe(
      false,
    );
  });

  /* The only compulsory part is the thing a reader could watch happen. */
  it('requires an observable outcome and nothing else about the shape', () => {
    expect(acceptanceCriterionSchema.safeParse({ ...criterion, then: '' }).success).toBe(false);
    expect(acceptanceCriterionSchema.safeParse({ ...criterion, given: '', when: '' }).success).toBe(
      true,
    );
  });

  it('reports which form a criterion took rather than forcing one', () => {
    expect(isGherkinShaped(criterion)).toBe(true);
    expect(isGherkinShaped({ given: '', when: '' })).toBe(false);
  });

  it('renders Given/When/Then when it has that shape', () => {
    expect(criterionText(criterion)).toBe(
      'Given a staff member is signed in\nWhen they submit a completed weekly timesheet\nThen the timesheet is recorded and shown as submitted',
    );
  });

  /*
   * A retention rule has no actor and no action. Forcing it into "Given a
   * user..." would make it read as something a person does, which it is not.
   */
  it('renders a standing rule as a sentence, not a distorted scenario', () => {
    expect(
      criterionText({
        ...criterion,
        given: '',
        when: '',
        then: 'Approval history is kept for every timesheet.',
      }),
    ).toBe('Approval history is kept for every timesheet.');
  });

  it('treats the same outcome on the same feature as a duplicate', () => {
    const other = { ...criterion, criterionKey: 'AC-002' };

    expect(criterionFingerprint(criterion)).toBe(criterionFingerprint(other));

    /* The same words about a different feature are not a duplicate. */
    expect(criterionFingerprint({ ...other, featureIds: ['ftr_2'] })).not.toBe(
      criterionFingerprint(criterion),
    );
  });

  it('numbers the next criterion after the highest one used', () => {
    expect(nextCriterionKey([])).toBe('AC-001');
    expect(nextCriterionKey(['AC-001', 'AC-009'])).toBe('AC-010');
    /* A gap left by a deletion is not reused — keys stay stable. */
    expect(nextCriterionKey(['AC-001', 'AC-003'])).toBe('AC-004');
  });
});

describe('thresholds nobody agreed to', () => {
  const evidence = 'Staff must submit timesheets weekly. Reports must load within 5 seconds.';

  /* Each of these is a contractual commitment invented by a text generator. */
  it('catches an invented figure of every kind', () => {
    const cases: readonly [string, string][] = [
      /* "within 2 seconds" is reported as the wider quote — a time limit. */
      ['The page responds within 2 seconds.', 'a time limit'],
      ['The report renders in 800 ms.', 'a response time'],
      ['The service is 99.9% available.', 'an availability figure'],
      ['It supports 500 concurrent users.', 'a concurrency target'],
      ['The system is WCAG 2.1 AA compliant.', 'an accessibility standard'],
      ['Data is encrypted with AES-256.', 'an encryption standard'],
      ['The system is GDPR compliant.', 'a compliance regime'],
      ['Records are retained for 7 years.', 'a retention period'],
      ['Supported on Chrome 120+.', 'a browser version'],
      ['Runs on iOS 17+.', 'a device or OS version'],
    ];

    for (const [text, kind] of cases) {
      expect(unstatedThresholds(text, evidence).map((finding) => finding.kind)).toContain(kind);
    }
  });

  /* A figure the client themselves stated is a quotation, and must pass. */
  it('allows a figure the approved evidence actually contains', () => {
    expect(unstatedThresholds('Reports must load within 5 seconds.', evidence)).toEqual([]);
  });

  /* The same shape with a different number is not the same commitment. */
  it('does not let a nearby figure launder a different one', () => {
    expect(unstatedThresholds('Reports must load within 2 seconds.', evidence)).toHaveLength(1);
  });

  it('says nothing about prose that commits to nothing', () => {
    expect(
      unstatedThresholds('The manager sees the submitted timesheet and approves it.', evidence),
    ).toEqual([]);
  });
});

describe('acceptance coverage', () => {
  const criterion = (
    key: string,
    requirementIds: string[],
    featureIds: string[],
    status: 'DRAFT' | 'EXCLUDED' = 'DRAFT',
  ) => ({ criterionKey: key, requirementIds, featureIds, status });

  it('counts what is covered, and is complete only when everything is', () => {
    const coverage = calculateCriteriaCoverage({
      applicableRequirementIds: ['REQ-001', 'REQ-002'],
      applicableFeatureIds: ['ftr_1', 'ftr_2'],
      criteria: [
        criterion('AC-001', ['REQ-001'], ['ftr_1']),
        criterion('AC-002', ['REQ-002'], ['ftr_2']),
      ],
      excludedRequirementIds: [],
      excludedFeatureIds: [],
    });

    expect(coverage.complete).toBe(true);
    expect(coverage.coveredRequirements).toBe(2);
    expect(coverage.coveredFeatures).toBe(2);
  });

  /* The number is arithmetic, not an aspiration. */
  it('is not complete while something approved has no criterion', () => {
    const coverage = calculateCriteriaCoverage({
      applicableRequirementIds: ['REQ-001', 'REQ-002'],
      applicableFeatureIds: ['ftr_1', 'ftr_2'],
      criteria: [criterion('AC-001', ['REQ-001'], ['ftr_1'])],
      excludedRequirementIds: [],
      excludedFeatureIds: [],
    });

    expect(coverage.complete).toBe(false);
    expect(coverage.uncoveredRequirementIds).toEqual(['REQ-002']);
    expect(coverage.uncoveredFeatureIds).toEqual(['ftr_2']);
  });

  it('accepts a deliberate exclusion as a disposition', () => {
    const coverage = calculateCriteriaCoverage({
      applicableRequirementIds: ['REQ-001', 'REQ-002'],
      applicableFeatureIds: ['ftr_1'],
      criteria: [criterion('AC-001', ['REQ-001'], ['ftr_1'])],
      excludedRequirementIds: ['REQ-002'],
      excludedFeatureIds: [],
    });

    expect(coverage.complete).toBe(true);
    expect(coverage.excludedRequirements).toBe(1);
  });

  /* A criterion somebody excluded is a decision not to state one, so it covers nothing. */
  it('does not let an excluded criterion cover anything', () => {
    const coverage = calculateCriteriaCoverage({
      applicableRequirementIds: ['REQ-001'],
      applicableFeatureIds: [],
      criteria: [criterion('AC-001', ['REQ-001'], [], 'EXCLUDED')],
      excludedRequirementIds: [],
      excludedFeatureIds: [],
    });

    expect(coverage.complete).toBe(false);
    expect(coverage.uncoveredRequirementIds).toEqual(['REQ-001']);
  });

  it('reports a criterion that cites nothing', () => {
    const coverage = calculateCriteriaCoverage({
      applicableRequirementIds: [],
      applicableFeatureIds: [],
      criteria: [criterion('AC-009', [], [])],
      excludedRequirementIds: [],
      excludedFeatureIds: [],
    });

    expect(coverage.unsupportedCriterionKeys).toEqual(['AC-009']);
    expect(coverage.complete).toBe(false);
  });
});

/* ========================================================== 4. Assumptions */

describe('an assumption', () => {
  const assumption: Assumption = {
    assumptionKey: 'AS-001',
    category: 'CLIENT',
    statement: 'The client will supply the payroll export format before development starts.',
    provenance: 'CLIENT_STATED',
    basis: 'Stated on the call of 4 August.',
    status: 'CONFIRMED',
    requirementIds: ['REQ-002'],
    featureIds: [],
    technologyIds: [],
    estimateUnitIds: [],
    owner: 'Client finance team',
    impact: 'HIGH',
    impactAreas: ['SCOPE', 'TIMELINE'],
    impactIfFalse: 'The export cannot be built to the right shape and the integration slips.',
    validationNeeded: 'Written confirmation of the format.',
    validateBy: 'Before development starts',
    confirmedBy: 'USER',
    confirmedAt: '2026-08-11T00:00:00.000Z',
    notes: '',
  };

  it('accepts a well-formed assumption', () => {
    expect(assumptionSchema.safeParse(assumption).success).toBe(true);
  });

  it('separates the provenance a person stands behind from a suggestion', () => {
    expect(isAuthoritativeProvenance('CLIENT_STATED')).toBe(true);
    expect(isAuthoritativeProvenance('USER_STATED')).toBe(true);
    expect(isAuthoritativeProvenance('CONFIRMED_CLARIFICATION')).toBe(true);
    expect(isAuthoritativeProvenance('APPROVED_ESTIMATION_ASSUMPTION')).toBe(true);
    expect(isAuthoritativeProvenance('APPROVED_TECHNICAL_ASSUMPTION')).toBe(true);
    expect(isAuthoritativeProvenance('MODEL_SUGGESTED')).toBe(false);
  });

  /* The rule the whole document exists for. */
  it('keeps a suggestion out of an approved document however plausible it reads', () => {
    expect(entersApprovedDocument(assumption)).toBe(true);

    expect(entersApprovedDocument({ status: 'DRAFT', provenance: 'MODEL_SUGGESTED' })).toBe(false);
    /* Confirmed, but resting on nothing but a model's suggestion. */
    expect(entersApprovedDocument({ status: 'CONFIRMED', provenance: 'MODEL_SUGGESTED' })).toBe(
      false,
    );
    /* Authoritative, but nobody has stood behind it yet. */
    expect(entersApprovedDocument({ status: 'DRAFT', provenance: 'CLIENT_STATED' })).toBe(false);
    expect(entersApprovedDocument({ status: 'REJECTED', provenance: 'CLIENT_STATED' })).toBe(false);
    /* Proved true is at least as good as confirmed. */
    expect(entersApprovedDocument({ status: 'VALIDATED', provenance: 'USER_STATED' })).toBe(true);
    /* Proved false is not. */
    expect(entersApprovedDocument({ status: 'INVALIDATED', provenance: 'USER_STATED' })).toBe(
      false,
    );
  });

  it('moves between states only where that makes sense', () => {
    expect(canTransitionAssumption('DRAFT', 'CONFIRMED')).toBe(true);
    expect(canTransitionAssumption('DRAFT', 'REJECTED')).toBe(true);
    expect(canTransitionAssumption('CONFIRMED', 'INVALIDATED')).toBe(true);
    /* A rejected assumption is reopened before it can be confirmed. */
    expect(canTransitionAssumption('REJECTED', 'CONFIRMED')).toBe(false);
    expect(canTransitionAssumption('REJECTED', 'DRAFT')).toBe(true);
    /* Nothing comes back from superseded. */
    expect(canTransitionAssumption('SUPERSEDED', 'CONFIRMED')).toBe(false);
    /* And a draft cannot be declared proved without being confirmed first. */
    expect(canTransitionAssumption('DRAFT', 'VALIDATED')).toBe(false);
  });

  it('numbers the next assumption after the highest used', () => {
    expect(nextAssumptionKey([])).toBe('AS-001');
    expect(nextAssumptionKey(['AS-001', 'AS-012'])).toBe('AS-013');
  });
});

describe('what a model may return for an assumption', () => {
  const candidate = {
    statement: 'Existing staff records will be migrated by the client.',
    category: 'DATA' as const,
    reasoning: 'The requirements describe existing records but no migration work.',
    requirementKeys: ['REQ-001'],
    impact: 'MEDIUM' as const,
    impactAreas: ['SCOPE' as const],
    impactIfFalse: 'Migration work would have to be added to the scope.',
    validationNeeded: 'Ask who is migrating the existing records.',
  };

  it('accepts a candidate', () => {
    expect(assumptionCandidateSchema.safeParse(candidate).success).toBe(true);
  });

  /*
   * The point of the schema: there is nowhere for a model to write the fields
   * that would make an assumption authoritative. This is not a rule it is asked
   * to follow — it is a shape it cannot express.
   */
  it('has no field for status, provenance, owner or confirmation', () => {
    for (const forbidden of [
      { status: 'CONFIRMED' },
      { provenance: 'CLIENT_STATED' },
      { owner: 'The client' },
      { confirmedBy: 'USER' },
      { confirmedAt: '2026-08-11T00:00:00.000Z' },
    ]) {
      expect(assumptionCandidateSchema.safeParse({ ...candidate, ...forbidden }).success).toBe(
        false,
      );
    }
  });

  it('stores a candidate as unmistakably not yet an assumption', () => {
    const stored = candidateToAssumption(candidate, 'AS-001', ['itm_1']);

    expect(stored.status).toBe('DRAFT');
    expect(stored.provenance).toBe('MODEL_SUGGESTED');
    expect(stored.owner).toBe('');
    expect(stored.confirmedBy).toBeUndefined();
    expect(entersApprovedDocument(stored)).toBe(false);
    /* The model's reasoning is kept as the basis, labelled as a suggestion. */
    expect(stored.basis).toBe(candidate.reasoning);
    expect(stored.requirementIds).toEqual(['itm_1']);
  });
});

describe('assumptions that cannot both be true', () => {
  const of = (key: string, statement: string, status: Assumption['status'] = 'CONFIRMED') => ({
    assumptionKey: key,
    statement,
    status,
  });

  it('catches the same proposition asserted and denied', () => {
    expect(
      contradictoryAssumptions([
        of('AS-001', 'The client will provide the payroll export.'),
        of('AS-002', 'The client will not provide the payroll export.'),
      ]),
    ).toEqual([['AS-001', 'AS-002']]);
  });

  it('leaves unrelated assumptions alone', () => {
    expect(
      contradictoryAssumptions([
        of('AS-001', 'The client will provide the payroll export.'),
        of('AS-002', 'Staff records will be migrated by the client.'),
      ]),
    ).toEqual([]);
  });

  /* Only confirmed assumptions contradict: candidates are still being considered. */
  it('ignores candidates, which are allowed to disagree', () => {
    expect(
      contradictoryAssumptions([
        of('AS-001', 'The client will provide the payroll export.', 'DRAFT'),
        of('AS-002', 'The client will not provide the payroll export.', 'DRAFT'),
      ]),
    ).toEqual([]);
  });
});

describe('the assumption summary', () => {
  it('counts the states and names what is unresolved and dangerous', () => {
    const summary = summariseAssumptions([
      {
        assumptionKey: 'AS-001',
        status: 'CONFIRMED',
        provenance: 'CLIENT_STATED',
        category: 'CLIENT',
        impact: 'HIGH',
      },
      {
        assumptionKey: 'AS-002',
        status: 'DRAFT',
        provenance: 'MODEL_SUGGESTED',
        category: 'DATA',
        impact: 'BLOCKING',
      },
      {
        assumptionKey: 'AS-003',
        status: 'REJECTED',
        provenance: 'MODEL_SUGGESTED',
        category: 'DATA',
        impact: 'LOW',
      },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.candidates).toBe(1);
    expect(summary.confirmed).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.blockingUnresolved).toEqual(['AS-002']);
    /* Only what would appear in an approved document is counted by category. */
    expect(summary.byCategory).toEqual({ CLIENT: 1 });
  });
});

/* ================================================== 5. Statement of Work */

describe('the SOW section template', () => {
  it('has the sections a commercial document needs, in order', () => {
    expect(SOW_SECTIONS.map((section) => section.order)).toEqual(
      SOW_SECTIONS.map((_, index) => index + 1),
    );
    expect(REQUIRED_SOW_SECTION_KEYS).toContain('scope-of-work');
    expect(REQUIRED_SOW_SECTION_KEYS).toContain('technology');
    expect(REQUIRED_SOW_SECTION_KEYS).toContain('timeline');
    expect(REQUIRED_SOW_SECTION_KEYS).toContain('acceptance');
    expect(REQUIRED_SOW_SECTION_KEYS).toContain('change-management');
  });

  /*
   * The four sections a model must not touch. Each is a transcription of an
   * approved artifact, and "improving" one means changing a version, a date or an
   * assumption's status by rewording it.
   */
  it('keeps the model out of the sections that quote approved artifacts', () => {
    for (const key of ['technology', 'timeline', 'milestones', 'assumptions']) {
      expect(isModelWritableSowSection(key)).toBe(false);
      expect(MODEL_WRITABLE_SOW_SECTIONS).not.toContain(key);
    }

    expect(isModelWritableSowSection('project-overview')).toBe(true);
    expect(isModelWritableSowSection('scope-of-work')).toBe(true);
  });

  it('lets a model return prose and nothing else', () => {
    expect(
      sowSectionDraftSchema.safeParse({
        key: 'objective',
        body: 'The objective is to replace the spreadsheet process.',
        requirementKeys: ['REQ-001'],
      }).success,
    ).toBe(true);

    /* No route to a hours figure, a date or a status. */
    for (const forbidden of [
      { totalHours: 400 },
      { deadline: '2027-01-01' },
      { status: 'FINAL' },
    ]) {
      expect(
        sowSectionDraftSchema.safeParse({
          key: 'objective',
          body: 'Text.',
          requirementKeys: [],
          ...forbidden,
        }).success,
      ).toBe(false);
    }
  });
});

describe('the legal boundary', () => {
  /* Every one of these creates or limits a legal obligation. */
  it('catches contractual language nobody supplied', () => {
    const cases: readonly [string, string][] = [
      ['This agreement is governed by the laws of England.', 'a governing-law clause'],
      ['The courts of London have exclusive jurisdiction.', 'a jurisdiction clause'],
      ['The supplier shall indemnify the client.', 'an indemnity'],
      ['We warrant the software is fit for a particular purpose.', 'a warranty'],
      ['Liability shall be limited to the fees paid.', 'a liability limitation'],
      ['Payment terms are net 30.', 'payment terms'],
      ['Liquidated damages apply to late delivery.', 'a penalty clause'],
      ['Intellectual property shall transfer on final payment.', 'an IP-transfer clause'],
      ['Service credits apply if availability drops.', 'SLA credits'],
      ['Either party may terminate this agreement on notice.', 'a termination clause'],
      ['The day rate is £600.', 'a price or rate'],
    ];

    for (const [text, term] of cases) {
      expect(prohibitedLegalTerms(text)).toContain(term);
    }
  });

  it('leaves an ordinary scope sentence alone', () => {
    expect(
      prohibitedLegalTerms(
        'The scope covers timesheet entry, manager approval and a payroll export.',
      ),
    ).toEqual([]);
  });
});

describe('internal methodology', () => {
  /*
   * Not embarrassment — disclosure is a commercial decision, and it should be a
   * person's, taken deliberately, not the accident of a word left in a prompt.
   */
  it('catches how the work gets built leaking into the client document', () => {
    const cases: readonly [string, string][] = [
      ['Development uses vibe coding throughout.', 'vibe coding'],
      ['Delivered through AI-assisted development.', 'AI-assisted development'],
      ['Our prompt engineering reduces effort.', 'prompt engineering'],
      ['Estimates produced with Qwen2.5.', 'a model name'],
      ['A language model drafts the code.', 'a language model'],
      ['A productivity multiplier of 1.4 was applied.', 'an internal productivity multiplier'],
      ['The confidence score for this estimate is 0.7.', 'an internal confidence figure'],
      ['This section was AI-generated.', 'AI generation'],
    ];

    for (const [text, term] of cases) {
      expect(internalMethodologyTerms(text)).toContain(term);
    }
  });

  it('says nothing about an ordinary implementation-approach sentence', () => {
    expect(
      internalMethodologyTerms(
        'Implementation proceeds in two-week increments, with a review at the end of each.',
      ),
    ).toEqual([]);
  });
});

describe('staffing', () => {
  it('catches a commitment to put specific people on the job', () => {
    expect(staffingClaims('Two backend developers will be assigned.')).not.toHaveLength(0);
    expect(staffingClaims('A team of four engineers delivers this.')).not.toHaveLength(0);
    expect(staffingClaims('Three full-time developers are allocated.')).not.toHaveLength(0);
  });

  /* Responsibilities claim nothing about headcount, and are what the SOW should say. */
  it('allows a responsibility without a headcount', () => {
    expect(staffingClaims('Backend engineering — API and server-side business logic.')).toEqual([]);
    expect(staffingClaims('Quality assurance — verifying the acceptance criteria.')).toEqual([]);
  });
});

describe('deliverables', () => {
  it('catches the generic promises a thin section reaches for', () => {
    expect(
      unsupportedDeliverables('A complete enterprise documentation package.'),
    ).not.toHaveLength(0);
    expect(unsupportedDeliverables('Ongoing support is included.')).not.toHaveLength(0);
    expect(unsupportedDeliverables('A comprehensive test suite.')).not.toHaveLength(0);
  });

  it('allows a deliverable that names what was scoped', () => {
    expect(
      unsupportedDeliverables('A web application covering timesheet entry and manager approval.'),
    ).toEqual([]);
  });
});

describe('the timeline the estimate approved', () => {
  const relative: SowTimeline = { basis: 'RELATIVE', workingWeeks: 12, acknowledgedRisk: false };

  /* No start date exists, so there is no date to compute from. */
  it('speaks relatively when the start date is unknown', () => {
    const statement = timelineStatement(relative);

    expect(statement).toContain('approximately 12 working weeks');
    expect(statement).toContain('following the agreed project commencement');
    expect(inventedDates(statement, relative)).toEqual([]);
    expect(statement).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('preserves a fixed deadline exactly', () => {
    const fixed: SowTimeline = {
      basis: 'FIXED_DEADLINE',
      workingWeeks: 10,
      deadline: '2027-03-31',
      acknowledgedRisk: true,
    };

    const statement = timelineStatement(fixed);

    expect(statement).toContain('2027-03-31');
    expect(inventedDates(statement, fixed)).toEqual([]);
  });

  it('uses the real start date when there is one', () => {
    const absolute: SowTimeline = {
      basis: 'ABSOLUTE_START',
      workingWeeks: 8,
      startDate: '2026-09-01',
      acknowledgedRisk: false,
    };

    expect(timelineStatement(absolute)).toContain('from 2026-09-01');
  });

  /* A date nobody approved, in a document somebody signs. */
  it('catches a calendar date that was invented', () => {
    expect(inventedDates('Delivery is planned for 2027-06-30.', relative)).toEqual(['2027-06-30']);
    expect(inventedDates('Phase one completes in Q3 2027.', relative)).toEqual(['Q3 2027']);
    expect(inventedDates('Go-live on 15 January 2027.', relative)).toEqual(['15 January 2027']);
  });

  it('allows the deadline the client themselves set', () => {
    const fixed: SowTimeline = {
      basis: 'FIXED_DEADLINE',
      deadline: '2027-03-31',
      acknowledgedRisk: false,
    };

    expect(inventedDates('Delivery by 2027-03-31.', fixed)).toEqual([]);
  });

  it('falls back to the estimate rather than inventing a duration', () => {
    expect(timelineStatement({ basis: 'RELATIVE', acknowledgedRisk: false })).toContain(
      'the duration set out in the approved estimate',
    );
  });
});

describe('scope reconciliation', () => {
  it('reconciles when the document states exactly the approved scope', () => {
    const result = reconcileSowScope({
      approvedFeatureIds: ['ftr_1', 'ftr_2'],
      statedFeatureIds: ['ftr_1', 'ftr_2'],
      exclusions: ['Native mobile applications are not included in this phase.'],
      includedText: 'Timesheet entry and manager approval.',
    });

    expect(result.reconciled).toBe(true);
  });

  /* Work the client has not been told they are buying — the one that gets missed. */
  it('catches approved scope the document leaves out', () => {
    const result = reconcileSowScope({
      approvedFeatureIds: ['ftr_1', 'ftr_2'],
      statedFeatureIds: ['ftr_1'],
      exclusions: [],
      includedText: 'Timesheet entry.',
    });

    expect(result.reconciled).toBe(false);
    expect(result.missingFeatureIds).toEqual(['ftr_2']);
  });

  it('catches scope the document invented', () => {
    const result = reconcileSowScope({
      approvedFeatureIds: ['ftr_1'],
      statedFeatureIds: ['ftr_1', 'ftr_9'],
      exclusions: [],
      includedText: 'Timesheet entry.',
    });

    expect(result.reconciled).toBe(false);
    expect(result.unknownFeatureIds).toEqual(['ftr_9']);
  });

  it('catches an excluded item described as included', () => {
    const result = reconcileSowScope({
      approvedFeatureIds: ['ftr_1'],
      statedFeatureIds: ['ftr_1'],
      exclusions: ['Native mobile applications'],
      includedText: 'The scope covers timesheet entry and native mobile applications.',
    });

    expect(result.reconciled).toBe(false);
    expect(result.contradictedExclusions).toEqual(['Native mobile applications']);
  });
});
