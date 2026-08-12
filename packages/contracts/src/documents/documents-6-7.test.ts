import { describe, expect, it } from 'vitest';

import {
  CLIENT_DEPENDENCY_CATEGORIES,
  DEPENDENCY_STATUSES,
  DEPENDENCY_TRANSITIONS,
  canTransitionDependency,
  clientDependencyDraftSchema,
  clientDependencySchema,
  dependencyFingerprint,
  isClientFacing,
  isDependencySatisfied,
  isTooVague,
  looksLikeSecret,
  nextDependencyKey,
  secretsInDependency,
  summariseDependencies,
  type ClientDependency,
} from './client-dependency.contract';
import {
  WBS_LEVELS,
  allocateEffort,
  reverseDependencyIndex,
  allocateRoleEffort,
  calculateWbsCoverage,
  isLeafLevel,
  nextOutlineNumber,
  reconcileWbsEffort,
  validateWbsStructure,
  wbsTaskDraftSchema,
  workPackageSchema,
  type WorkPackage,
} from './work-breakdown.contract';

/**
 * Secret-shaped strings, assembled at runtime.
 *
 * These have to look exactly like real credentials or they do not test the detector —
 * and a literal in the source is then flagged forever by every secret scanner that
 * ever reads this repository, including the one on the push path. Joining the pieces
 * gives the tests the identical string with nothing secret-shaped committed.
 */
function shaped(...parts: readonly string[]): string {
  return parts.join('_');
}

const STRIPE_SHAPED = shaped('sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc');
const AWS_SHAPED = `AKIA${'IOSFODNN7EXAMPLE'}`;
const GITHUB_SHAPED = shaped('ghp', '16C7e42F292c6912E7710c838347Ae178B4a');
const JWT_SHAPED = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'dozjgNryP4J3jVmNHl0w5N-XgL0n3I9PlFUP0THsR8U',
].join('.');

/* ------------------------------------------------------------- fixtures */

function workPackage(overrides: Partial<WorkPackage> = {}): WorkPackage {
  return {
    wbsId: '1.1.1',
    parentId: '1.1',
    sequence: 0,
    level: 'TASK',
    phase: 'Delivery',
    module: 'Checkout',
    submodule: 'Payment',
    feature: 'Card payment',
    task: 'Implement the card payment endpoint',
    description: 'Server-side card charge against the approved provider.',
    workKind: 'FEATURE',
    requirementIds: ['REQ-001'],
    featureIds: ['F-001'],
    estimateUnitIds: ['E-001'],
    technologyIds: [],
    ownerRole: 'BACKEND',
    effort: { BACKEND: 12 },
    totalEffort: 12,
    relativeStartDay: 1,
    relativeFinishDay: 3,
    workingDuration: 3,
    predecessors: [],
    parallelizable: false,
    onCriticalPath: true,
    deliverable: 'A working card payment endpoint',
    status: 'NOT_STARTED',
    notes: '',
    ...overrides,
  };
}

function dependency(overrides: Partial<ClientDependency> = {}): ClientDependency {
  return {
    dependencyKey: 'CD-001',
    category: 'CREDENTIALS',
    module: 'Checkout',
    feature: 'Card payment',
    dependency: 'Sandbox credentials for the payment provider',
    description: 'Test-mode API credentials for the provider named in the approved stack.',
    purpose: 'Card payment cannot be built or tested without provider access.',
    sourceKinds: ['TECHNOLOGY_STACK'],
    requirementIds: ['REQ-001'],
    featureIds: ['F-001'],
    wbsIds: ['1.1.1'],
    technologyIds: ['payments'],
    clientOwner: '',
    internalOwner: '',
    relativeDue: 'before payment integration work starts',
    priority: 'HIGH',
    blocking: 'FEATURE',
    impactIfDelayed: 'Payment work cannot start and the integration milestone moves.',
    expectedFormat: 'Sandbox key pair delivered through your secret manager',
    status: 'NOT_REQUESTED',
    validationNote: '',
    credentialsRequired: true,
    remarks: '',
    ...overrides,
  };
}

/* ==================================================== work breakdown */

describe('WBS levels', () => {
  it('names six levels, only the last of which holds effort', () => {
    expect(WBS_LEVELS).toHaveLength(6);
    expect(WBS_LEVELS.filter(isLeafLevel)).toEqual(['TASK']);
  });
});

describe('workPackageSchema', () => {
  it('accepts a task that traces to an estimate unit', () => {
    expect(workPackageSchema.parse(workPackage())).toMatchObject({ wbsId: '1.1.1' });
  });

  it('requires an outline number, not an arbitrary id', () => {
    expect(workPackageSchema.safeParse(workPackage({ wbsId: 'task-one' })).success).toBe(false);
    expect(workPackageSchema.safeParse(workPackage({ wbsId: '1' })).success).toBe(true);
    expect(workPackageSchema.safeParse(workPackage({ wbsId: '1.2.3.4' })).success).toBe(true);
  });

  it('rejects unknown fields, so a stray hours column cannot ride along', () => {
    expect(workPackageSchema.safeParse({ ...workPackage(), overriddenHours: 40 }).success).toBe(
      false,
    );
  });
});

describe('allocateEffort', () => {
  /*
   * The property that matters. A work breakdown whose hours differ from the approved
   * estimate is the one thing this document must never be, so every split is checked
   * against its own total rather than against a hand-written expectation.
   */
  it('always sums to exactly the total it was given', () => {
    const cases: readonly { total: number; weights: readonly number[] }[] = [
      { total: 12, weights: [1, 1, 1] },
      { total: 10, weights: [1, 1, 1] },
      { total: 7, weights: [1, 1, 1] },
      { total: 1, weights: [1, 1, 1, 1] },
      { total: 100, weights: [3, 1] },
      { total: 13, weights: [5, 3, 2] },
      { total: 40, weights: [1] },
      { total: 0, weights: [1, 1] },
      /* The shape Phase 6 actually produces: fractional hours. */
      { total: 4.48, weights: [1, 1, 1] },
      { total: 0.03, weights: [1, 1] },
      { total: 70.46, weights: [3, 2, 1] },
    ];

    for (const { total, weights } of cases) {
      const split = allocateEffort(total, weights);

      expect(split).toHaveLength(weights.length);
      /* Summed in hundredths, because that is the precision the split works in. */
      expect(split.reduce((sum, value) => sum + Math.round(value * 100), 0)).toBe(
        Math.round(total * 100),
      );
      expect(split.every((value) => value >= 0)).toBe(true);
    }
  });

  it('splits ten across three as 3.34/3.33/3.33, never as three threes', () => {
    /* Rounding each part independently would lose an hour, or invent two. */
    expect(allocateEffort(10, [1, 1, 1])).toEqual([3.34, 3.33, 3.33]);
  });

  it('keeps a fractional estimate figure intact', () => {
    /*
     * 4.48 backend hours is an ordinary estimate line. A whole-hour split would turn
     * it into 4, and a breakdown that loses half an hour per task does not reconcile
     * with the plan it came from.
     */
    const split = allocateEffort(4.48, [1, 1]);

    expect(split).toEqual([2.24, 2.24]);
  });

  it('respects relative weights', () => {
    expect(allocateEffort(100, [3, 1])).toEqual([75, 25]);
    expect(allocateEffort(12, [5, 3, 2])).toEqual([6, 3.6, 2.4]);
  });

  it('gives the same answer every time it is asked', () => {
    const first = allocateEffort(17, [2, 2, 2, 1]);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(allocateEffort(17, [2, 2, 2, 1])).toEqual(first);
    }
  });

  it('returns nothing for no children, and zeroes for no work', () => {
    expect(allocateEffort(40, [])).toEqual([]);
    expect(allocateEffort(0, [1, 2])).toEqual([0, 0]);
    expect(allocateEffort(40, [0, 0])).toEqual([0, 0]);
  });
});

describe('allocateRoleEffort', () => {
  it('preserves every role total independently', () => {
    const parts = allocateRoleEffort({ BACKEND: 10, QA: 4.48, FRONTEND: 0 }, [1, 1, 1]);

    expect(parts).toHaveLength(3);
    expect(parts.reduce((sum, part) => sum + Math.round((part.BACKEND ?? 0) * 100), 0)).toBe(1_000);
    expect(parts.reduce((sum, part) => sum + Math.round((part.QA ?? 0) * 100), 0)).toBe(448);
    /* A role with no work contributes no key rather than a zero-valued one. */
    expect(parts.every((part) => part.FRONTEND === undefined)).toBe(true);
  });
});

describe('reconcileWbsEffort', () => {
  it('reconciles when the leaves add up to the approved estimate', () => {
    const result = reconcileWbsEffort({
      approvedByRole: { BACKEND: 12, QA: 4 },
      approvedUnitIds: ['E-001', 'E-002'],
      leaves: [
        workPackage({ effort: { BACKEND: 12 }, estimateUnitIds: ['E-001'] }),
        workPackage({ effort: { QA: 4 }, estimateUnitIds: ['E-002'] }),
      ],
    });

    expect(result.reconciles).toBe(true);
    expect(result.approvedTotal).toBe(16);
    expect(result.wbsTotal).toBe(16);
    expect(result.mismatchedRoles).toEqual([]);
  });

  it('catches a per-role mismatch that two roles hide in the total', () => {
    /*
     * The most misleading possible result: sixteen hours either way, with four of them
     * moved from QA to backend. A total-only check would call this correct.
     */
    const result = reconcileWbsEffort({
      approvedByRole: { BACKEND: 12, QA: 4 },
      approvedUnitIds: ['E-001'],
      leaves: [workPackage({ effort: { BACKEND: 16 }, estimateUnitIds: ['E-001'] })],
    });

    expect(result.wbsTotal).toBe(result.approvedTotal);
    expect(result.reconciles).toBe(false);
    expect(result.mismatchedRoles).toEqual([
      { role: 'BACKEND', approved: 12, inWbs: 16 },
      { role: 'QA', approved: 4, inWbs: 0 },
    ]);
  });

  it('reports approved work that no task covers', () => {
    const result = reconcileWbsEffort({
      approvedByRole: { BACKEND: 12 },
      approvedUnitIds: ['E-001', 'E-002'],
      leaves: [workPackage({ effort: { BACKEND: 12 }, estimateUnitIds: ['E-001'] })],
    });

    expect(result.unmappedEstimateUnitIds).toEqual(['E-002']);
    expect(result.reconciles).toBe(false);
  });

  it('reports a task citing an estimate unit the approved plan does not have', () => {
    const result = reconcileWbsEffort({
      approvedByRole: { BACKEND: 12 },
      approvedUnitIds: ['E-001'],
      leaves: [
        workPackage({ effort: { BACKEND: 12 }, estimateUnitIds: ['E-001'] }),
        workPackage({ wbsId: '1.1.2', effort: {}, estimateUnitIds: ['E-999'] }),
      ],
    });

    expect(result.unknownEstimateUnitIds).toEqual(['E-999']);
    expect(result.reconciles).toBe(false);
  });

  it('leaves excluded work out of the arithmetic entirely', () => {
    const result = reconcileWbsEffort({
      approvedByRole: { BACKEND: 12 },
      approvedUnitIds: ['E-001'],
      leaves: [
        workPackage({ effort: { BACKEND: 12 }, estimateUnitIds: ['E-001'] }),
        workPackage({
          wbsId: '1.1.2',
          status: 'EXCLUDED',
          effort: { BACKEND: 40 },
          estimateUnitIds: ['E-500'],
        }),
      ],
    });

    expect(result.reconciles).toBe(true);
    expect(result.wbsTotal).toBe(12);
  });
});

describe('calculateWbsCoverage', () => {
  it('is complete when every requirement, feature and unit is covered', () => {
    const coverage = calculateWbsCoverage({
      applicableRequirementIds: ['REQ-001'],
      applicableFeatureIds: ['F-001'],
      applicableEstimateUnitIds: ['E-001'],
      leaves: [workPackage()],
    });

    expect(coverage.complete).toBe(true);
    expect(coverage.mappedRequirements).toBe(1);
    expect(coverage.mappedFeatures).toBe(1);
  });

  /*
   * Feature coverage is a measurement, not a formality. These four are the ones that
   * would pass whether or not the calculation looked at features at all, so each is
   * written to fail if it ever stops doing so.
   */
  it('drops below complete when an approved feature has no work against it', () => {
    const coverage = calculateWbsCoverage({
      applicableRequirementIds: ['REQ-001'],
      applicableFeatureIds: ['F-001', 'F-002'],
      applicableEstimateUnitIds: ['E-001'],
      leaves: [workPackage()],
    });

    expect(coverage.unmappedFeatureIds).toEqual(['F-002']);
    expect(coverage.mappedFeatures).toBe(1);
    expect(coverage.applicableFeatures).toBe(2);
    expect(coverage.complete).toBe(false);
  });

  it('rejects a task citing a feature the listing does not contain', () => {
    const coverage = calculateWbsCoverage({
      applicableRequirementIds: ['REQ-001'],
      applicableFeatureIds: ['F-001'],
      applicableEstimateUnitIds: ['E-001'],
      leaves: [workPackage({ featureIds: ['F-001', 'F-999'] })],
    });

    expect(coverage.unknownFeatureIds).toEqual(['F-999']);
    expect(coverage.complete).toBe(false);
  });

  it('does not let overhead work reduce feature coverage', () => {
    /*
     * CI setup has no Feature Listing row and should not have one. Counting it as
     * untraced would report a breakdown as incomplete for being exactly right.
     */
    const coverage = calculateWbsCoverage({
      applicableRequirementIds: ['REQ-001'],
      applicableFeatureIds: ['F-001'],
      applicableEstimateUnitIds: ['E-001', 'E-002'],
      leaves: [
        workPackage(),
        workPackage({
          wbsId: '1.2.1',
          workKind: 'OVERHEAD',
          featureIds: [],
          requirementIds: [],
          estimateUnitIds: ['E-002'],
          effort: { DEVOPS: 6 },
          totalEffort: 6,
        }),
      ],
    });

    expect(coverage.complete).toBe(true);
    expect(coverage.overheadWbsIds).toEqual(['1.2.1']);
    expect(coverage.overheadHours).toBe(6);
    expect(coverage.untracedFeatureWorkIds).toEqual([]);
  });

  it('flags feature work that carries no feature', () => {
    const coverage = calculateWbsCoverage({
      applicableRequirementIds: [],
      applicableFeatureIds: [],
      applicableEstimateUnitIds: ['E-001'],
      leaves: [workPackage({ featureIds: [], workKind: 'FEATURE' })],
    });

    expect(coverage.untracedFeatureWorkIds).toEqual(['1.1.1']);
    expect(coverage.complete).toBe(false);
  });

  it('names the requirements no task covers', () => {
    const coverage = calculateWbsCoverage({
      applicableRequirementIds: ['REQ-001', 'REQ-002'],
      applicableFeatureIds: [],
      applicableEstimateUnitIds: ['E-001'],
      leaves: [workPackage()],
    });

    expect(coverage.unmappedRequirementIds).toEqual(['REQ-002']);
    expect(coverage.complete).toBe(false);
  });

  it('flags a task that traces to nothing at all', () => {
    const coverage = calculateWbsCoverage({
      applicableRequirementIds: [],
      applicableFeatureIds: [],
      applicableEstimateUnitIds: [],
      leaves: [
        workPackage({ wbsId: '1.9.9', requirementIds: [], featureIds: [], estimateUnitIds: [] }),
      ],
    });

    expect(coverage.unsupportedWbsIds).toEqual(['1.9.9']);
    expect(coverage.complete).toBe(false);
  });
});

describe('validateWbsStructure', () => {
  const container = (id: string, parentId?: string): WorkPackage =>
    workPackage({ wbsId: id, parentId, level: 'MODULE', task: '', effort: {}, totalEffort: 0 });

  it('accepts a well-formed tree', () => {
    expect(
      validateWbsStructure([
        container('1'),
        container('1.1', '1'),
        workPackage({ wbsId: '1.1.1', parentId: '1.1' }),
        workPackage({ wbsId: '1.1.2', parentId: '1.1', predecessors: ['1.1.1'] }),
      ]),
    ).toEqual([]);
  });

  it('rejects a parent that is not in the document', () => {
    const problems = validateWbsStructure([workPackage({ wbsId: '1.1.1', parentId: '9.9' })]);

    expect(problems.map((problem) => problem.kind)).toContain('unknown_parent');
  });

  it('rejects a row that is its own parent', () => {
    const problems = validateWbsStructure([workPackage({ wbsId: '1.1.1', parentId: '1.1.1' })]);

    expect(problems.map((problem) => problem.kind)).toContain('self_parent');
  });

  it('rejects work hanging off a task', () => {
    const problems = validateWbsStructure([
      workPackage({ wbsId: '1.1.1', parentId: undefined }),
      workPackage({ wbsId: '1.1.2', parentId: '1.1.1' }),
    ]);

    expect(problems.map((problem) => problem.kind)).toContain('leaf_with_children');
  });

  it('rejects a row that waits for itself', () => {
    const problems = validateWbsStructure([
      workPackage({ wbsId: '1.1.1', parentId: undefined, predecessors: ['1.1.1'] }),
    ]);

    expect(problems.map((problem) => problem.kind)).toContain('self_predecessor');
  });

  it('rejects an unknown predecessor', () => {
    const problems = validateWbsStructure([
      workPackage({ wbsId: '1.1.1', parentId: undefined, predecessors: ['4.4'] }),
    ]);

    expect(problems.map((problem) => problem.kind)).toContain('unknown_predecessor');
  });

  it('finds a cycle in the predecessor graph and names the loop', () => {
    const problems = validateWbsStructure([
      workPackage({ wbsId: '1', parentId: undefined, predecessors: ['3'] }),
      workPackage({ wbsId: '2', parentId: undefined, predecessors: ['1'] }),
      workPackage({ wbsId: '3', parentId: undefined, predecessors: ['2'] }),
    ]);

    const cycle = problems.find((problem) => problem.kind === 'cycle');

    expect(cycle).toBeDefined();
    expect(cycle?.detail).toContain('→');
  });

  it('finds a cycle in the hierarchy without looping forever', () => {
    const problems = validateWbsStructure([
      workPackage({ wbsId: '1', parentId: '2', level: 'MODULE' }),
      workPackage({ wbsId: '2', parentId: '1', level: 'MODULE' }),
    ]);

    expect(problems.map((problem) => problem.kind)).toContain('cycle');
  });

  it('rejects waiting on excluded work, which will never finish', () => {
    const problems = validateWbsStructure([
      workPackage({ wbsId: '1', parentId: undefined, status: 'EXCLUDED' }),
      workPackage({ wbsId: '2', parentId: undefined, predecessors: ['1'] }),
    ]);

    expect(problems.map((problem) => problem.kind)).toContain('excluded_predecessor');
  });

  it('rejects two rows sharing an outline number', () => {
    const problems = validateWbsStructure([
      workPackage({ wbsId: '1.1', parentId: undefined }),
      workPackage({ wbsId: '1.1', parentId: undefined }),
    ]);

    expect(problems.map((problem) => problem.kind)).toContain('duplicate_row');
  });
});

describe('nextOutlineNumber', () => {
  it('numbers the first child one', () => {
    expect(nextOutlineNumber('1.2', [])).toBe('1.2.1');
    expect(nextOutlineNumber(undefined, [])).toBe('1');
  });

  it('continues after the highest existing sibling', () => {
    expect(nextOutlineNumber('1.2', ['1.2.1', '1.2.2'])).toBe('1.2.3');
    expect(nextOutlineNumber(undefined, ['1', '2'])).toBe('3');
  });

  it('ignores grandchildren when numbering children', () => {
    expect(nextOutlineNumber('1', ['1.1', '1.1.9', '1.2'])).toBe('1.3');
  });
});

describe('wbsTaskDraftSchema', () => {
  it('accepts wording, grouping and a weighted split', () => {
    expect(
      wbsTaskDraftSchema.safeParse({
        estimateUnitId: 'E-001',
        phase: 'Delivery',
        module: 'Checkout',
        submodule: 'Payment',
        task: 'Implement the card payment endpoint',
        description: 'Server-side charge.',
        deliverable: 'A working endpoint',
        parts: [{ task: 'Validation', description: 'Input checks.', weight: 2 }],
      }).success,
    ).toBe(true);
  });

  /*
   * The numbers a model must not be able to state. These are not warnings the
   * generator is asked to respect — there is no field to put them in, so a model
   * that tries produces a parse failure rather than a plausible wrong figure.
   */
  it('has nowhere to put hours, dates or a critical-path claim', () => {
    const base = {
      estimateUnitId: 'E-001',
      phase: '',
      module: '',
      submodule: '',
      task: 'A task',
      description: '',
      deliverable: '',
    };

    for (const extra of [
      { totalEffort: 40 },
      { effort: { BACKEND: 40 } },
      { hours: 40 },
      { startDate: '2026-03-01' },
      { relativeStartDay: 3 },
      { onCriticalPath: true },
      { status: 'COMPLETE' },
    ]) {
      expect(wbsTaskDraftSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });

  it('caps a split at a dozen parts and a weight of ten', () => {
    const base = {
      estimateUnitId: 'E-001',
      phase: '',
      module: '',
      submodule: '',
      task: 'A task',
      description: '',
      deliverable: '',
    };

    expect(
      wbsTaskDraftSchema.safeParse({
        ...base,
        parts: Array.from({ length: 13 }, () => ({ task: 'x', description: '', weight: 1 })),
      }).success,
    ).toBe(false);

    expect(
      wbsTaskDraftSchema.safeParse({
        ...base,
        parts: [{ task: 'x', description: '', weight: 11 }],
      }).success,
    ).toBe(false);
  });
});

/* ============================================= client dependency sheet */

describe('client dependency categories', () => {
  it('offers no category for internal sequencing work', () => {
    /* Every category names something only somebody outside the team can do. */
    for (const category of CLIENT_DEPENDENCY_CATEGORIES) {
      expect(isClientFacing(category)).toBe(true);
    }

    expect(CLIENT_DEPENDENCY_CATEGORIES).not.toContain('INTERNAL');
  });
});

describe('clientDependencySchema', () => {
  it('accepts a grounded, actionable row', () => {
    expect(clientDependencySchema.parse(dependency())).toMatchObject({ dependencyKey: 'CD-001' });
  });

  it('requires at least one source, so nothing is ungrounded', () => {
    expect(clientDependencySchema.safeParse(dependency({ sourceKinds: [] })).success).toBe(false);
  });

  it('requires a key of the CD-001 shape', () => {
    expect(clientDependencySchema.safeParse(dependency({ dependencyKey: 'dep1' })).success).toBe(
      false,
    );
  });

  it('rejects an empty request', () => {
    expect(clientDependencySchema.safeParse(dependency({ dependency: '' })).success).toBe(false);
  });
});

describe('the dependency lifecycle', () => {
  it('keeps received apart from accepted', () => {
    /*
     * The distinction the whole status model exists for. Credentials arrive and do not
     * work; a data file arrives in the wrong encoding. Only a checked item unblocks.
     */
    expect(isDependencySatisfied('RECEIVED')).toBe(false);
    expect(isDependencySatisfied('PARTIALLY_RECEIVED')).toBe(false);
    expect(isDependencySatisfied('VALIDATING')).toBe(false);
    expect(isDependencySatisfied('ACCEPTED')).toBe(true);
    expect(isDependencySatisfied('WAIVED')).toBe(true);
  });

  it('reaches accepted only from received or a check in progress', () => {
    const canAccept = DEPENDENCY_STATUSES.filter((status) =>
      canTransitionDependency(status, 'ACCEPTED'),
    );

    expect(canAccept).toEqual(['RECEIVED', 'VALIDATING']);
  });

  it('never skips from requested straight to accepted', () => {
    expect(canTransitionDependency('REQUESTED', 'ACCEPTED')).toBe(false);
    expect(canTransitionDependency('NOT_REQUESTED', 'ACCEPTED')).toBe(false);
  });

  it('walks a normal item from unrequested to accepted', () => {
    expect(canTransitionDependency('NOT_REQUESTED', 'REQUESTED')).toBe(true);
    expect(canTransitionDependency('REQUESTED', 'RECEIVED')).toBe(true);
    expect(canTransitionDependency('RECEIVED', 'VALIDATING')).toBe(true);
    expect(canTransitionDependency('VALIDATING', 'ACCEPTED')).toBe(true);
  });

  it('lets a rejected item be asked for again', () => {
    expect(canTransitionDependency('REJECTED', 'REQUESTED')).toBe(true);
  });

  it('treats superseded as final', () => {
    expect(DEPENDENCY_TRANSITIONS.SUPERSEDED).toEqual([]);
  });

  it('names every status in the transition table', () => {
    for (const status of DEPENDENCY_STATUSES) {
      expect(DEPENDENCY_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe('looksLikeSecret', () => {
  /*
   * Erring towards refusal on purpose. A false positive costs somebody a rewording; a
   * false negative writes a live credential into an immutable document version that
   * then gets exported, emailed and pasted into chat.
   */
  it('refuses text that carries an actual secret', () => {
    const secrets = [
      STRIPE_SHAPED,
      AWS_SHAPED,
      GITHUB_SHAPED,
      JWT_SHAPED,
      '-----BEGIN RSA PRIVATE KEY-----',
      'password: hunter2000',
      'client_secret=abcdef123456',
      'mongodb://admin:letmein@db.example.com:27017',
    ];

    for (const secret of secrets) {
      expect(looksLikeSecret(secret).length).toBeGreaterThan(0);
    }
  });

  it('allows a row that talks about credentials without carrying one', () => {
    const allowed = [
      'Sandbox credentials for the payment provider',
      'API key for the SMS gateway, delivered through your secret manager',
      'Read-only database access for the migration',
      'An account with permission to create webhooks',
      'The client must confirm which environment the token belongs to',
    ];

    for (const text of allowed) {
      expect(looksLikeSecret(text)).toEqual([]);
    }
  });

  it('finds a secret in any text field of a row, not just the headline', () => {
    expect(
      secretsInDependency(dependency({ remarks: 'temporary key sk_test_abcdefgh12345678' })),
    ).not.toEqual([]);
    expect(
      secretsInDependency(dependency({ validationNote: 'password: correct-horse' })),
    ).not.toEqual([]);
    expect(secretsInDependency(dependency())).toEqual([]);
  });
});

describe('isTooVague', () => {
  it('refuses a dependency nobody can action or close', () => {
    const vague = [
      'Client must provide all required information',
      'The client will provide the necessary details',
      'All required approvals',
      'Timely client cooperation',
      'As and when required',
      'Client sign-off',
    ];

    for (const text of vague) {
      expect(isTooVague(text)).toBe(true);
    }
  });

  it('accepts a request with a subject somebody can hand over', () => {
    const actionable = [
      'Sandbox credentials for the payment provider',
      'Approval of the checkout wireframes',
      'Product catalogue export as CSV',
      'Sign-off on the payment integration test results',
    ];

    for (const text of actionable) {
      expect(isTooVague(text)).toBe(false);
    }
  });
});

describe('dependencyFingerprint', () => {
  it('treats the same request asked twice as one dependency', () => {
    expect(dependencyFingerprint(dependency())).toBe(
      dependencyFingerprint(
        dependency({ dependency: 'sandbox   credentials for the Payment Provider!' }),
      ),
    );
  });

  it('keeps different categories apart', () => {
    expect(dependencyFingerprint(dependency({ category: 'ACCESS' }))).not.toBe(
      dependencyFingerprint(dependency({ category: 'CREDENTIALS' })),
    );
  });
});

describe('nextDependencyKey', () => {
  it('starts at CD-001 and continues after the highest', () => {
    expect(nextDependencyKey([])).toBe('CD-001');
    expect(nextDependencyKey(['CD-001', 'CD-002'])).toBe('CD-003');
    expect(nextDependencyKey(['CD-010', 'CD-002'])).toBe('CD-011');
  });

  it('ignores anything that is not a dependency key', () => {
    expect(nextDependencyKey(['REQ-004', 'CD-001'])).toBe('CD-002');
  });
});

describe('summariseDependencies', () => {
  it('counts what is outstanding and what is blocking', () => {
    const summary = summariseDependencies([
      dependency({ dependencyKey: 'CD-001', status: 'ACCEPTED', blocking: 'FEATURE' }),
      dependency({ dependencyKey: 'CD-002', status: 'RECEIVED', blocking: 'MILESTONE' }),
      dependency({ dependencyKey: 'CD-003', status: 'REQUESTED', blocking: 'NONE' }),
      dependency({ dependencyKey: 'CD-004', status: 'REJECTED', blocking: 'RELEASE' }),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.accepted).toBe(1);
    expect(summary.received).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.outstanding).toBe(3);
    /* Received counts as outstanding here, because nobody has checked it. */
    expect(summary.blockingOutstanding).toEqual(['CD-002', 'CD-004']);
  });

  it('counts by category', () => {
    const summary = summariseDependencies([
      dependency({ category: 'ACCESS' }),
      dependency({ category: 'ACCESS' }),
      dependency({ category: 'CONTENT' }),
    ]);

    expect(summary.byCategory).toEqual({ ACCESS: 2, CONTENT: 1 });
  });
});

describe('clientDependencyDraftSchema', () => {
  it('accepts a stated need with its reason', () => {
    expect(
      clientDependencyDraftSchema.safeParse({
        category: 'CONTENT',
        dependency: 'Product catalogue export',
        description: 'The live catalogue, so the import can be built against real data.',
        purpose: 'The import cannot be written without knowing the real shape.',
        requirementKeys: ['REQ-004'],
        expectedFormat: 'CSV or JSON export',
        impactIfDelayed: 'The import cannot be tested.',
      }).success,
    ).toBe(true);
  });

  /* No owner, no date, no status: every field that would commit a person or unblock work. */
  it('has nowhere to put an owner, a date, a status or a blocking claim', () => {
    const base = {
      category: 'CONTENT' as const,
      dependency: 'Product catalogue export',
      description: '',
      purpose: '',
      requirementKeys: [],
      expectedFormat: '',
      impactIfDelayed: '',
    };

    for (const extra of [
      { clientOwner: 'Priya' },
      { internalOwner: 'the delivery lead' },
      { actualDueDate: '2026-03-01' },
      { relativeDue: 'before sprint two' },
      { status: 'REQUESTED' },
      { priority: 'CRITICAL' },
      { blocking: 'RELEASE' },
      { credentialsRequired: true },
    ]) {
      expect(clientDependencyDraftSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
});

/* ============================================ the derived reverse index */

/**
 * The reverse view of the dependency relationship.
 *
 * The Client Dependency Sheet owns the link in its own `wbsIds`; this reads it backwards
 * so a work package can show what it waits for. Derived rather than stored, so
 * generating document 7 never has to rewrite document 6 — including an issued one.
 */
describe('reverseDependencyIndex', () => {
  const link = (overrides: Record<string, unknown> = {}) => ({
    dependencyKey: 'CD-001',
    dependency: 'Sandbox credentials for the payment provider',
    category: 'CREDENTIALS',
    status: 'REQUESTED',
    blocking: 'FEATURE',
    wbsIds: ['1.1.1'],
    satisfied: false,
    ...overrides,
  });

  const index = (dependencies: readonly ReturnType<typeof link>[], overrides = {}) =>
    reverseDependencyIndex({
      dependencies,
      sheetVersion: 1,
      sheetStatus: 'APPROVED',
      sheetCurrentness: 'CURRENT' as const,
      ...overrides,
    });

  it('lets a work package find the dependency that names it', () => {
    const result = index([link()]);

    expect(result.byWbsId['1.1.1']).toHaveLength(1);
    expect(result.byWbsId['1.1.1']![0]!.dependencyKey).toBe('CD-001');
  });

  it('lists every dependency waiting on one task', () => {
    const result = index([link(), link({ dependencyKey: 'CD-002', category: 'CONTENT' })]);

    expect(result.byWbsId['1.1.1']!.map((entry) => entry.dependencyKey)).toEqual([
      'CD-001',
      'CD-002',
    ]);
  });

  it('shows one dependency against every task it affects', () => {
    const result = index([link({ wbsIds: ['1.1.1', '1.1.2', '1.2.1'] })]);

    for (const wbsId of ['1.1.1', '1.1.2', '1.2.1']) {
      expect(result.byWbsId[wbsId]!.map((entry) => entry.dependencyKey)).toEqual(['CD-001']);
    }
  });

  it('has no entry for a task nothing waits on', () => {
    expect(index([link()]).byWbsId['9.9.9']).toBeUndefined();
  });

  it('marks a blocking outstanding item, and a satisfied one as not blocking', () => {
    expect(index([link()]).byWbsId['1.1.1']![0]!.blockingOutstanding).toBe(true);

    expect(
      index([link({ status: 'ACCEPTED', satisfied: true })]).byWbsId['1.1.1']![0]!
        .blockingOutstanding,
    ).toBe(false);

    /* Nothing waiting on it is not blocking, whatever its status. */
    expect(index([link({ blocking: 'NONE' })]).byWbsId['1.1.1']![0]!.blockingOutstanding).toBe(
      false,
    );
  });

  it('carries the sheet’s currentness onto every entry', () => {
    /*
     * A reverse link into a stale sheet is still worth showing — the dependency probably
     * still exists — but a reader has to be told, or the breakdown appears to make a
     * current claim it cannot support.
     */
    const result = index([link()], { sheetCurrentness: 'OUTDATED' as const });

    expect(result.sheetCurrentness).toBe('OUTDATED');
    expect(result.byWbsId['1.1.1']![0]!.sheetCurrentness).toBe('OUTDATED');
  });

  it('is empty when no dependency names any work', () => {
    expect(index([link({ wbsIds: [] })]).byWbsId).toEqual({});
  });
});
