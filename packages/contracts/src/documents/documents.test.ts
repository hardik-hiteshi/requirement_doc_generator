import { describe, expect, it } from 'vitest';

import { calculateDocumentBlockers } from './document-blockers';
import {
  documentOutdatedReasons,
  DOCUMENT_DEPENDENCIES,
  documentsDependingOn,
  documentsDependingOnUpstream,
  lockFor,
} from './document-dependency';
import {
  hasProposal,
  isSectionProtected,
  mayReplaceDirectly,
  type DocumentSection,
} from './document-section.contract';
import { diffDocuments } from './document-snapshot.contract';
import {
  canGenerateDocument,
  canTransitionDocument,
  DOCUMENT_STATUSES,
  DOCUMENT_TRANSITIONS,
  isDocumentAuthoritative,
  isDocumentEditable,
} from './document-status.contract';
import {
  DOCUMENT_LABELS,
  DOCUMENT_ORDER,
  DOCUMENT_SHAPE_BY_TYPE,
  DOCUMENT_TYPES,
  IMPLEMENTED_DOCUMENT_TYPES,
  isImplementedDocumentType,
} from './document-type.contract';
import {
  MODEL_RAISABLE_KINDS,
  validationIsCurrent,
  validationPermitsApproval,
  worstSeverity,
  type DocumentValidation,
  type ValidationFinding,
} from './document-validation.contract';
import {
  csvField,
  csvHours,
  featureCsvRow,
  featureListingCsv,
  FEATURE_CSV_COLUMNS,
  FEATURE_CSV_HEADER,
  joinDetailPoints,
  otherRolesCell,
  splitDetailPoints,
  validateFeatureCsv,
} from './feature-csv';
import {
  aggregateFeatureEffort,
  attemptsEffortEdit,
  calculateFeatureCoverage,
  featureTotalHours,
  findDuplicateFeatures,
  inconsistentHierarchy,
  otherRoleEffort,
  reconcileFeatureEffort,
  type FeatureRow,
} from './feature-listing.contract';
import {
  forbiddenContent,
  REQUIRED_UNDERSTANDING_KEYS,
  understandingSection,
  UNDERSTANDING_SECTIONS,
} from './understanding.contract';

/* ------------------------------------------------------------- the types */

describe('document types', () => {
  it('declares all seven and implements two', () => {
    expect(DOCUMENT_TYPES).toHaveLength(7);
    expect(IMPLEMENTED_DOCUMENT_TYPES).toEqual(['OUR_UNDERSTANDING', 'FEATURE_LISTING']);
  });

  it('reports honestly which are available', () => {
    expect(isImplementedDocumentType('OUR_UNDERSTANDING')).toBe(true);
    expect(isImplementedDocumentType('FEATURE_LISTING')).toBe(true);
    /* Declared for the graph, and not pretending to exist. */
    expect(isImplementedDocumentType('STATEMENT_OF_WORK')).toBe(false);
    expect(isImplementedDocumentType('WORK_BREAKDOWN_STRUCTURE')).toBe(false);
  });

  it('orders Understanding before Feature Listing', () => {
    expect(DOCUMENT_ORDER.OUR_UNDERSTANDING).toBe(1);
    expect(DOCUMENT_ORDER.FEATURE_LISTING).toBe(2);
  });

  it('gives every type a label, a description and a shape', () => {
    for (const type of DOCUMENT_TYPES) {
      expect(DOCUMENT_LABELS[type].length).toBeGreaterThan(0);
      expect(DOCUMENT_SHAPE_BY_TYPE[type]).toBeDefined();
      expect(DOCUMENT_ORDER[type]).toBeGreaterThan(0);
    }
  });
});

/* ---------------------------------------------------------- the lifecycle */

describe('document status transitions', () => {
  it('gives every status a transition entry', () => {
    for (const status of DOCUMENT_STATUSES) {
      expect(DOCUMENT_TRANSITIONS[status]).toBeDefined();
    }
  });

  /* The distinction the whole status list exists for. */
  it('treats FINAL as a terminus, not another editable state', () => {
    expect(DOCUMENT_TRANSITIONS.FINAL).toEqual([]);
    expect(canTransitionDocument('FINAL', 'DRAFT')).toBe(false);
    expect(canTransitionDocument('FINAL', 'APPROVED')).toBe(false);
    expect(isDocumentEditable('FINAL')).toBe(false);
  });

  it('separates APPROVED from FINAL', () => {
    expect(canTransitionDocument('APPROVED', 'FINAL')).toBe(true);
    expect(isDocumentAuthoritative('APPROVED')).toBe(true);
    expect(isDocumentAuthoritative('FINAL')).toBe(true);
    expect(isDocumentAuthoritative('DRAFT')).toBe(false);
    expect(isDocumentAuthoritative('OUTDATED')).toBe(false);
  });

  it('runs generation only from a settled state', () => {
    expect(canGenerateDocument('NOT_STARTED')).toBe(true);
    expect(canGenerateDocument('DRAFT')).toBe(true);
    expect(canGenerateDocument('OUTDATED')).toBe(true);
    expect(canGenerateDocument('FAILED')).toBe(true);
    /* One run at a time, and never over an issued document. */
    expect(canGenerateDocument('GENERATING')).toBe(false);
    expect(canGenerateDocument('QUEUED')).toBe(false);
    expect(canGenerateDocument('FINAL')).toBe(false);
    expect(canGenerateDocument('APPROVED')).toBe(false);
  });

  it('makes re-approving stale content take a deliberate step', () => {
    /* OUTDATED cannot go straight back to APPROVED. */
    expect(canTransitionDocument('OUTDATED', 'APPROVED')).toBe(false);
    expect(canTransitionDocument('OUTDATED', 'DRAFT')).toBe(true);
    expect(canTransitionDocument('DRAFT', 'APPROVED')).toBe(true);
  });

  it('lets an approved document go out of date without being edited', () => {
    expect(canTransitionDocument('APPROVED', 'OUTDATED')).toBe(true);
  });
});

/* ----------------------------------------------------- the dependency graph */

describe('the document dependency graph', () => {
  it('builds Understanding on the baseline alone', () => {
    expect(DOCUMENT_DEPENDENCIES.OUR_UNDERSTANDING).toEqual({
      upstream: ['REQUIREMENT_BASELINE'],
      documents: [],
    });
  });

  it('builds Feature Listing on Understanding, the stack and the estimate', () => {
    const dependencies = DOCUMENT_DEPENDENCIES.FEATURE_LISTING;

    expect(dependencies.documents).toEqual(['OUR_UNDERSTANDING']);
    expect(dependencies.upstream).toContain('REQUIREMENT_BASELINE');
    expect(dependencies.upstream).toContain('TECHNOLOGY_STACK');
    expect(dependencies.upstream).toContain('ESTIMATION_SNAPSHOT');
  });

  it('knows what depends on a document', () => {
    expect(documentsDependingOn('OUR_UNDERSTANDING')).toContain('FEATURE_LISTING');
    expect(documentsDependingOn('FEATURE_LISTING')).not.toContain('OUR_UNDERSTANDING');
  });

  it('knows what depends on an upstream artifact', () => {
    expect(documentsDependingOnUpstream('ESTIMATION_SNAPSHOT')).toContain('FEATURE_LISTING');
    expect(documentsDependingOnUpstream('ESTIMATION_SNAPSHOT')).not.toContain('OUR_UNDERSTANDING');
  });

  it('has no cycles, so a document is never its own prerequisite', () => {
    const visit = (type: (typeof DOCUMENT_TYPES)[number], seen: string[]): void => {
      expect(seen).not.toContain(type);

      for (const prerequisite of DOCUMENT_DEPENDENCIES[type].documents) {
        visit(prerequisite, [...seen, type]);
      }
    };

    for (const type of DOCUMENT_TYPES) {
      visit(type, []);
    }
  });
});

describe('locking', () => {
  const implemented = [...IMPLEMENTED_DOCUMENT_TYPES];

  it('unlocks Understanding once the baseline is approved', () => {
    expect(
      lockFor(
        'OUR_UNDERSTANDING',
        { availableUpstream: ['REQUIREMENT_BASELINE'], documentStatuses: {} },
        implemented,
      ),
    ).toBeNull();
  });

  it('locks Understanding without a baseline, and says which input is missing', () => {
    const lock = lockFor(
      'OUR_UNDERSTANDING',
      { availableUpstream: [], documentStatuses: {} },
      implemented,
    );

    expect(lock?.reason).toBe('upstream_missing');
    expect(lock?.summary).toContain('approved requirements');
  });

  /* The ordering rule the whole document sequence rests on. */
  it('locks Feature Listing until Understanding is approved', () => {
    const state = {
      availableUpstream: [
        'REQUIREMENT_BASELINE',
        'TECHNOLOGY_STACK',
        'ESTIMATION_SNAPSHOT',
      ] as const,
      documentStatuses: { OUR_UNDERSTANDING: 'DRAFT' as const },
    };

    expect(lockFor('FEATURE_LISTING', state, implemented)?.reason).toBe('prerequisite_document');

    expect(
      lockFor(
        'FEATURE_LISTING',
        { ...state, documentStatuses: { OUR_UNDERSTANDING: 'APPROVED' } },
        implemented,
      ),
    ).toBeNull();
  });

  it('reports an unimplemented document as unavailable before anything else', () => {
    const lock = lockFor(
      'STATEMENT_OF_WORK',
      { availableUpstream: [], documentStatuses: {} },
      implemented,
    );

    expect(lock?.reason).toBe('not_implemented');
  });
});

describe('outdated propagation', () => {
  it('reports a changed baseline for a document that depends on it', () => {
    const reasons = documentOutdatedReasons({
      type: 'OUR_UNDERSTANDING',
      generatedAgainst: { baselineVersion: 1 },
      current: { baselineVersion: 2 },
      changedPrerequisites: [],
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.cause).toBe('baseline_changed');
    expect(reasons[0]?.generatedAgainst).toBe('v1');
    expect(reasons[0]?.currentVersion).toBe('v2');
  });

  it('ignores an input the document does not depend on', () => {
    /* Understanding does not read the estimate, so a new estimate is not its problem. */
    expect(
      documentOutdatedReasons({
        type: 'OUR_UNDERSTANDING',
        generatedAgainst: { estimateVersion: 1 },
        current: { estimateVersion: 5 },
        changedPrerequisites: [],
      }),
    ).toEqual([]);
  });

  it('reports a changed estimate for Feature Listing', () => {
    const reasons = documentOutdatedReasons({
      type: 'FEATURE_LISTING',
      generatedAgainst: { estimateVersion: 2 },
      current: { estimateVersion: 3 },
      changedPrerequisites: [],
    });

    expect(reasons.map((reason) => reason.cause)).toEqual(['estimate_changed']);
  });

  it('reports a prerequisite document that moved', () => {
    const reasons = documentOutdatedReasons({
      type: 'FEATURE_LISTING',
      generatedAgainst: {},
      current: {},
      changedPrerequisites: ['OUR_UNDERSTANDING'],
    });

    expect(reasons[0]?.cause).toBe('prerequisite_document_changed');
    expect(reasons[0]?.documentType).toBe('OUR_UNDERSTANDING');
  });

  it('says nothing when versions match', () => {
    expect(
      documentOutdatedReasons({
        type: 'FEATURE_LISTING',
        generatedAgainst: { baselineVersion: 2, stackVersion: 1, estimateVersion: 3 },
        current: { baselineVersion: 2, stackVersion: 1, estimateVersion: 3 },
        changedPrerequisites: [],
      }),
    ).toEqual([]);
  });

  it('does not report an input the document never used', () => {
    /* Written before a stack existed: not stale with respect to one. */
    expect(
      documentOutdatedReasons({
        type: 'FEATURE_LISTING',
        generatedAgainst: {},
        current: { stackVersion: 4 },
        changedPrerequisites: [],
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------- section protection */

describe('section protection', () => {
  const section = (overrides: Partial<DocumentSection> = {}): DocumentSection => ({
    sectionId: 'sec_1',
    key: 'project-overview',
    title: 'Project Overview',
    order: 1,
    body: 'A timesheet system.',
    origin: 'GENERATED',
    references: [],
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  });

  it('protects what a person wrote and nothing else', () => {
    expect(isSectionProtected('GENERATED')).toBe(false);
    expect(isSectionProtected('USER_EDITED')).toBe(true);
    expect(isSectionProtected('USER_AUTHORED')).toBe(true);
  });

  it('replaces generated content directly', () => {
    expect(mayReplaceDirectly(section())).toBe(true);
  });

  it('refuses to replace edited content directly', () => {
    expect(mayReplaceDirectly(section({ origin: 'USER_EDITED' }))).toBe(false);
    expect(mayReplaceDirectly(section({ origin: 'USER_AUTHORED' }))).toBe(false);
  });

  it('recognises a pending proposal', () => {
    expect(hasProposal(section())).toBe(false);
    expect(hasProposal(section({ proposedBody: 'A rewritten overview.' }))).toBe(true);
    /* An empty proposal is not a proposal. */
    expect(hasProposal(section({ proposedBody: '' }))).toBe(false);
  });
});

/* --------------------------------------------------------- Our Understanding */

describe('the Our Understanding template', () => {
  it('has contiguous ordering and unique keys', () => {
    const keys = UNDERSTANDING_SECTIONS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);

    UNDERSTANDING_SECTIONS.forEach((entry, index) => {
      expect(entry.order).toBe(index + 1);
    });
  });

  it('covers every section the specification names', () => {
    const keys = UNDERSTANDING_SECTIONS.map((entry) => entry.key);

    for (const key of [
      'project-overview',
      'business-objective',
      'solution-understanding',
      'intended-users',
      'major-modules',
      'core-workflows',
      'functional-scope',
      'non-functional',
      'integrations',
      'data-reporting',
      'platforms',
      'constraints',
      'out-of-scope',
      'clarifications',
      'open-items',
    ]) {
      expect(keys).toContain(key);
    }
  });

  it('requires evidence for the sections that could otherwise become filler', () => {
    for (const key of ['non-functional', 'integrations', 'platforms', 'out-of-scope']) {
      expect(understandingSection(key)?.requiresEvidence).toBe(true);
    }
  });

  it('cannot be approved without an overview and a scope', () => {
    expect(REQUIRED_UNDERSTANDING_KEYS).toContain('project-overview');
    expect(REQUIRED_UNDERSTANDING_KEYS).toContain('functional-scope');
  });
});

describe('forbidden client-facing content', () => {
  it.each([
    ['The system will provide 99.9% uptime.', 'availability'],
    ['It supports 10,000 concurrent users.', 'user-volume'],
    ['Responses are sub-second.', 'performance'],
    ['The platform is GDPR compliant.', 'compliance'],
    ['Screens meet WCAG 2.1 AA.', 'accessibility'],
    ['Built using AI-assisted development.', 'methodology'],
    ['An industry-leading, seamless experience.', 'marketing'],
  ])('catches %j', (body) => {
    expect(forbiddenContent(body).length).toBeGreaterThan(0);
  });

  it('leaves a supported statement alone', () => {
    expect(
      forbiddenContent(
        'Managers approve timesheets before export, and every approval is recorded with its author and time.',
      ),
    ).toEqual([]);
  });

  it('reports the reason rather than editing the text', () => {
    const found = forbiddenContent('We guarantee 99.99% uptime.');

    expect(found[0]?.reason).toContain('availability target');
    expect(found[0]?.match).toContain('99.99');
  });
});

/* ---------------------------------------------------------- Feature Listing */

describe('the strict Feature Listing CSV', () => {
  const row = (overrides: Partial<FeatureRow> = {}): FeatureRow => ({
    featureId: 'ftr_1',
    requirementIds: ['REQ-001'],
    module: 'Timesheets',
    submodule: 'Approval',
    screen: 'Approval queue',
    description: 'A manager approves a timesheet',
    effort: { BACKEND: 8, FRONTEND: 6, QA: 4 },
    totalHours: 18,
    estimateUnitIds: ['eu_1'],
    technologyIds: ['react'],
    references: [],
    reviewStatus: 'GENERATED',
    mappingConfidence: 0.9,
    notes: '',
    order: 0,
    ...overrides,
  });

  it('has exactly eight columns, spelled and ordered as specified', () => {
    expect(FEATURE_CSV_COLUMNS).toEqual([
      'Module',
      'Sub Module',
      'Screen',
      'Detailed Feature Description',
      'Estimated Hours - Backend Dev',
      'Estimated Hours - Frontend Dev',
      'Estimated Hours - QA',
      'Estimated Hours - Other Roles (mention role)',
    ]);
    expect(FEATURE_CSV_COLUMNS).toHaveLength(8);
  });

  it('quotes every header cell', () => {
    expect(FEATURE_CSV_HEADER).toBe(
      '"Module","Sub Module","Screen","Detailed Feature Description",' +
        '"Estimated Hours - Backend Dev","Estimated Hours - Frontend Dev",' +
        '"Estimated Hours - QA","Estimated Hours - Other Roles (mention role)"',
    );
  });

  it('quotes every value, including empty ones', () => {
    const line = featureCsvRow(row({ submodule: '', screen: '' }));
    const fields = line.split(',');

    /* Eight fields, and every one of them wrapped. */
    expect(fields).toHaveLength(8);
    for (const field of fields) {
      expect(field.startsWith('"')).toBe(true);
      expect(field.endsWith('"')).toBe(true);
    }
    expect(line).toContain('"",""');
  });

  it('escapes an inner quote by doubling it', () => {
    expect(csvField('A "quoted" phrase')).toBe('"A ""quoted"" phrase"');
  });

  it('flattens a newline rather than emitting a multi-line cell', () => {
    expect(csvField('First line\nSecond line')).toBe('"First line Second line"');
  });

  it('leaves a blank Screen blank for work with no interface', () => {
    const line = featureCsvRow(row({ screen: '', module: 'Payments API' }));

    expect(line.split(',')[2]).toBe('""');
  });

  it('writes whole hours without decimals and halves with them', () => {
    expect(csvHours(8)).toBe('8');
    expect(csvHours(6.5)).toBe('6.5');
    expect(csvHours(0)).toBe('');
    expect(csvHours(undefined)).toBe('');
  });

  it('names each additional role in the Other Roles column', () => {
    const cell = otherRolesCell(row({ effort: { BACKEND: 8, MOBILE: 12, UI_UX: 4 } }));

    expect(cell).toBe('Mobile Dev: 12 | UI/UX: 4');
  });

  it('keeps mobile and UI/UX out of the three named columns', () => {
    const line = featureCsvRow(
      row({ effort: { BACKEND: 10, FRONTEND: 0, QA: 5, MOBILE: 12, DEVOPS: 2 } }),
    );
    const fields = line.split(',');

    expect(fields[4]).toBe('"10"');
    expect(fields[5]).toBe('""');
    expect(fields[6]).toBe('"5"');
    expect(fields[7]).toBe('"DevOps: 2 | Mobile Dev: 12"');
  });

  it('separates description points with a pipe', () => {
    expect(joinDetailPoints(['A manager approves', 'The approval is recorded'])).toBe(
      'A manager approves | The approval is recorded',
    );
    expect(splitDetailPoints('One | Two | Three')).toEqual(['One', 'Two', 'Three']);
  });

  it('round-trips a description through the separator', () => {
    const points = ['A user signs in', 'A failed attempt is logged'];
    expect(splitDetailPoints(joinDetailPoints(points))).toEqual(points);
  });

  it('serialises a whole document with CRLF line endings', () => {
    const csv = featureListingCsv([row(), row({ featureId: 'ftr_2', screen: '' })]);

    expect(csv.startsWith(FEATURE_CSV_HEADER)).toBe(true);
    expect(csv).toContain('\r\n');
    expect(validateFeatureCsv(csv)).toEqual({ valid: true });
  });

  it('rejects output whose header has drifted', () => {
    const broken = featureListingCsv([row()]).replace('"Sub Module"', '"Submodule"');

    expect(validateFeatureCsv(broken).valid).toBe(false);
  });

  it('rejects a row with an unquoted field', () => {
    const broken = `${FEATURE_CSV_HEADER}\r\n"A","B","C","D","1","2","3",unquoted\r\n`;

    expect(validateFeatureCsv(broken).valid).toBe(false);
  });

  it('keeps a description containing a comma in one field', () => {
    const csv = featureListingCsv([row({ description: 'Sign in, then record hours' })]);

    expect(validateFeatureCsv(csv)).toEqual({ valid: true });
  });
});

describe('feature effort', () => {
  it('adds hours per role across the units behind a feature', () => {
    expect(
      aggregateFeatureEffort([
        { effort: { BACKEND: 8, QA: 2 } },
        { effort: { BACKEND: 4, FRONTEND: 6 } },
      ]),
    ).toEqual({ BACKEND: 12, QA: 2, FRONTEND: 6 });
  });

  it('totals a row across every role', () => {
    expect(featureTotalHours({ BACKEND: 8, FRONTEND: 6.5, MOBILE: 2 })).toBe(16.5);
  });

  it('lists only the roles without a column of their own', () => {
    expect(otherRoleEffort({ BACKEND: 8, MOBILE: 4, QA: 0, DEVOPS: 1 })).toEqual([
      { role: 'DEVOPS', hours: 1 },
      { role: 'MOBILE', hours: 4 },
    ]);
  });
});

describe('estimate reconciliation', () => {
  const units = [
    { id: 'eu_1', totalHours: 10, excluded: false },
    { id: 'eu_2', totalHours: 20, excluded: false },
    { id: 'eu_3', totalHours: 5, excluded: true },
  ];

  it('reconciles when the rows cite every counted unit', () => {
    const result = reconcileFeatureEffort({
      estimateUnits: units,
      rows: [{ estimateUnitIds: ['eu_1'] }, { estimateUnitIds: ['eu_2'] }],
    });

    expect(result.reconciles).toBe(true);
    expect(result.estimateHours).toBe(30);
    expect(result.documentHours).toBe(30);
    expect(result.differenceHours).toBe(0);
  });

  /* A unit supporting two features must not be double counted. */
  it('counts a shared unit once', () => {
    const result = reconcileFeatureEffort({
      estimateUnits: units,
      rows: [{ estimateUnitIds: ['eu_1', 'eu_2'] }, { estimateUnitIds: ['eu_2'] }],
    });

    expect(result.documentHours).toBe(30);
    expect(result.reconciles).toBe(true);
  });

  it('reports a unit no row mentions', () => {
    const result = reconcileFeatureEffort({
      estimateUnits: units,
      rows: [{ estimateUnitIds: ['eu_1'] }],
    });

    expect(result.reconciles).toBe(false);
    expect(result.uncitedUnitIds).toEqual(['eu_2']);
    expect(result.differenceHours).toBe(20);
  });

  it('reports a row citing a unit that is not in the estimate', () => {
    const result = reconcileFeatureEffort({
      estimateUnits: units,
      rows: [{ estimateUnitIds: ['eu_1', 'eu_2', 'eu_ghost'] }],
    });

    expect(result.reconciles).toBe(false);
    expect(result.unknownUnitIds).toEqual(['eu_ghost']);
  });

  it('ignores an excluded unit on both sides', () => {
    const result = reconcileFeatureEffort({
      estimateUnits: units,
      rows: [{ estimateUnitIds: ['eu_1', 'eu_2'] }],
    });

    expect(result.estimateHours).toBe(30);
    expect(result.uncitedUnitIds).not.toContain('eu_3');
  });
});

describe('feature coverage', () => {
  it('reaches 100% only when every requirement has a disposition', () => {
    const complete = calculateFeatureCoverage({
      applicableRequirementIds: ['REQ-1', 'REQ-2'],
      rows: [{ featureId: 'f1', requirementIds: ['REQ-1', 'REQ-2'] }],
      excludedRequirementIds: [],
    });

    expect(complete.percentage).toBe(100);
    expect(complete.unresolved).toBe(0);
  });

  it('never reports complete while a requirement is unresolved', () => {
    const partial = calculateFeatureCoverage({
      applicableRequirementIds: ['REQ-1', 'REQ-2', 'REQ-3'],
      rows: [{ featureId: 'f1', requirementIds: ['REQ-1'] }],
      excludedRequirementIds: [],
    });

    expect(partial.percentage).toBeLessThan(100);
    expect(partial.unresolved).toBe(2);
    expect(partial.unresolvedRequirementIds).toEqual(['REQ-2', 'REQ-3']);
  });

  it('counts a deliberate exclusion as handled', () => {
    const withExclusion = calculateFeatureCoverage({
      applicableRequirementIds: ['REQ-1', 'REQ-2'],
      rows: [{ featureId: 'f1', requirementIds: ['REQ-1'] }],
      excludedRequirementIds: ['REQ-2'],
    });

    expect(withExclusion.percentage).toBe(100);
    expect(withExclusion.excluded).toBe(1);
    expect(withExclusion.unresolved).toBe(0);
  });

  it('flags a row citing no approved requirement', () => {
    const coverage = calculateFeatureCoverage({
      applicableRequirementIds: ['REQ-1'],
      rows: [
        { featureId: 'f1', requirementIds: ['REQ-1'] },
        { featureId: 'f2', requirementIds: ['REQ-invented'] },
      ],
      excludedRequirementIds: [],
    });

    expect(coverage.unsupportedRows).toBe(1);
    expect(coverage.unsupportedFeatureIds).toEqual(['f2']);
  });

  it('reports zero rather than complete for an empty baseline', () => {
    expect(
      calculateFeatureCoverage({
        applicableRequirementIds: [],
        rows: [],
        excludedRequirementIds: [],
      }).percentage,
    ).toBe(0);
  });
});

describe('feature quality checks', () => {
  const base = { module: 'Timesheets', submodule: 'Entry', screen: 'Weekly grid' };

  it('detects two rows describing the same thing', () => {
    const duplicates = findDuplicateFeatures([
      { featureId: 'f1', ...base, description: 'Record hours per day' },
      { featureId: 'f2', ...base, description: 'record  hours per day!' },
      { featureId: 'f3', ...base, description: 'Submit the week' },
    ]);

    expect(duplicates).toEqual([['f1', 'f2']]);
  });

  it('treats the same screen name in different modules as distinct', () => {
    expect(
      findDuplicateFeatures([
        { featureId: 'f1', module: 'A', submodule: '', screen: 'List', description: 'Show items' },
        { featureId: 'f2', module: 'B', submodule: '', screen: 'List', description: 'Show items' },
      ]),
    ).toEqual([]);
  });

  it('detects a submodule appearing under two modules', () => {
    expect(
      inconsistentHierarchy([
        { module: 'Timesheets', submodule: 'Approval' },
        { module: 'Expenses', submodule: 'Approval' },
      ]),
    ).toEqual([{ submodule: 'approval', modules: ['Expenses', 'Timesheets'] }]);
  });

  it('ignores rows with no submodule', () => {
    expect(
      inconsistentHierarchy([
        { module: 'A', submodule: '' },
        { module: 'B', submodule: '' },
      ]),
    ).toEqual([]);
  });
});

describe('effort edit authority', () => {
  it('permits descriptive edits', () => {
    expect(attemptsEffortEdit({ module: 'Timesheets', description: 'Better wording' })).toBe(false);
  });

  it.each([['effort'], ['totalHours'], ['backendHours'], ['estimatedHours']])(
    'recognises %s as an attempt to change the estimate',
    (field) => {
      expect(attemptsEffortEdit({ [field]: 12 })).toBe(true);
    },
  );
});

/* --------------------------------------------------------------- validation */

describe('document validation', () => {
  const finding = (overrides: Partial<ValidationFinding> = {}): ValidationFinding => ({
    kind: 'unsupported_statement',
    severity: 'WARNING',
    detectedBy: 'MODEL',
    summary: 'A statement with no requirement behind it.',
    action: 'Remove it or cite a requirement.',
    subjectIds: ['sec_1'],
    ...overrides,
  });

  const validation = (findings: ValidationFinding[]): DocumentValidation => ({
    validationId: 'val_1',
    documentVersion: 3,
    ranAt: '2026-08-10T00:00:00.000Z',
    severity: worstSeverity(findings),
    findings,
    modelAssisted: true,
  });

  it('reports the worst severity present', () => {
    expect(worstSeverity([])).toBe('PASS');
    expect(worstSeverity([finding()])).toBe('WARNING');
    expect(worstSeverity([finding(), finding({ severity: 'BLOCKING' })])).toBe('BLOCKING');
  });

  it('treats an acknowledged warning as settled', () => {
    expect(worstSeverity([finding({ acknowledgedAt: '2026-08-10T01:00:00.000Z' })])).toBe('PASS');
  });

  it('refuses approval on a blocking finding', () => {
    expect(validationPermitsApproval(validation([finding({ severity: 'BLOCKING' })]))).toBe(false);
  });

  it('permits approval on a warning', () => {
    expect(validationPermitsApproval(validation([finding()]))).toBe(true);
  });

  it('refuses approval when nothing has been validated', () => {
    expect(validationPermitsApproval(null)).toBe(false);
  });

  it('treats a result from an earlier version as out of date', () => {
    expect(validationIsCurrent(validation([]), 3)).toBe(true);
    expect(validationIsCurrent(validation([]), 4)).toBe(false);
    expect(validationIsCurrent(null, 3)).toBe(false);
  });

  /* A model may add a judgement; it may not rule on arithmetic. */
  it('limits what a model is allowed to raise', () => {
    expect(MODEL_RAISABLE_KINDS).toContain('unsupported_statement');
    expect(MODEL_RAISABLE_KINDS).toContain('terminology_inconsistency');
    expect(MODEL_RAISABLE_KINDS).not.toContain('effort_mismatch');
    expect(MODEL_RAISABLE_KINDS).not.toContain('unknown_requirement');
    expect(MODEL_RAISABLE_KINDS).not.toContain('requirement_uncovered');
  });
});

/* ---------------------------------------------------------------- blockers */

describe('document blockers', () => {
  const section = (overrides: Partial<DocumentSection> = {}): DocumentSection => ({
    sectionId: 'sec_1',
    key: 'project-overview',
    title: 'Project Overview',
    order: 1,
    body: 'A timesheet system.',
    origin: 'GENERATED',
    references: [],
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  });

  const input = (overrides: Partial<Parameters<typeof calculateDocumentBlockers>[0]> = {}) => ({
    generated: true,
    sections: [section()],
    requiredSectionKeys: ['project-overview'],
    validation: null,
    outdatedReasons: [],
    coverage: null,
    reconciliation: null,
    unapprovedPrerequisites: [],
    ...overrides,
  });

  it('reports nothing to do on a clean document', () => {
    expect(calculateDocumentBlockers(input())).toEqual([]);
  });

  it('reports only the gate when nothing is generated', () => {
    const blockers = calculateDocumentBlockers(input({ generated: false }));

    expect(blockers.map((blocker) => blocker.kind)).toEqual(['not_generated']);
  });

  it('reports only the prerequisite when it is unapproved', () => {
    const blockers = calculateDocumentBlockers(
      input({ unapprovedPrerequisites: ['OUR_UNDERSTANDING'], outdatedReasons: [] }),
    );

    expect(blockers.map((blocker) => blocker.kind)).toEqual(['prerequisite_not_approved']);
  });

  it('blocks on an unresolved proposal', () => {
    const blockers = calculateDocumentBlockers(
      input({
        sections: [section({ origin: 'USER_EDITED', proposedBody: 'A rewrite.' })],
      }),
    );

    expect(blockers.map((blocker) => blocker.kind)).toContain('unresolved_proposal');
  });

  it('blocks on an empty required section', () => {
    const blockers = calculateDocumentBlockers(input({ sections: [section({ body: '   ' })] }));

    expect(blockers.map((blocker) => blocker.kind)).toContain('empty_required_section');
  });

  it('blocks on incomplete coverage and names the requirements', () => {
    const blockers = calculateDocumentBlockers(
      input({
        coverage: {
          applicable: 3,
          represented: 1,
          excluded: 0,
          unresolved: 2,
          unsupportedRows: 0,
          percentage: 33.3,
          unresolvedRequirementIds: ['REQ-2', 'REQ-3'],
          unsupportedFeatureIds: [],
        },
      }),
    );

    const blocker = blockers.find((entry) => entry.kind === 'coverage_incomplete');
    expect(blocker?.subjectIds).toEqual(['REQ-2', 'REQ-3']);
  });

  it('blocks when the hours do not match the estimate', () => {
    const blockers = calculateDocumentBlockers(
      input({
        reconciliation: {
          estimateHours: 100,
          documentHours: 80,
          differenceHours: 20,
          reconciles: false,
          uncitedUnitIds: ['eu_9'],
          unknownUnitIds: [],
        },
      }),
    );

    expect(blockers.map((blocker) => blocker.kind)).toContain('effort_mismatch');
  });

  it('reports outdated inputs without touching the content', () => {
    const blockers = calculateDocumentBlockers(
      input({
        outdatedReasons: [
          { cause: 'baseline_changed', summary: 'The approved requirements changed.' },
        ],
      }),
    );

    expect(blockers.map((blocker) => blocker.kind)).toContain('outdated_inputs');
  });
});

/* ------------------------------------------------------------------- diff */

describe('comparing versions', () => {
  const entries = (bodies: Record<string, string>) =>
    Object.entries(bodies).map(([key, body]) => ({ key, title: key, body }));

  it('reports a changed section and leaves the rest alone', () => {
    const diff = diffDocuments(
      { version: 1, entries: entries({ a: 'One', b: 'Two' }) },
      { version: 2, entries: entries({ a: 'One', b: 'Two, revised' }) },
    );

    expect(diff.changedCount).toBe(1);
    expect(diff.entries.find((entry) => entry.key === 'b')?.kind).toBe('CHANGED');
    expect(diff.entries.find((entry) => entry.key === 'a')?.kind).toBe('UNCHANGED');
  });

  it('ignores whitespace reflow', () => {
    const diff = diffDocuments(
      { version: 1, entries: entries({ a: 'One two\nthree' }) },
      { version: 2, entries: entries({ a: 'One  two three' }) },
    );

    expect(diff.changedCount).toBe(0);
  });

  it('reports an inserted section as one addition', () => {
    const diff = diffDocuments(
      { version: 1, entries: entries({ a: 'One', c: 'Three' }) },
      { version: 2, entries: entries({ a: 'One', b: 'Two', c: 'Three' }) },
    );

    expect(diff.changedCount).toBe(1);
    expect(diff.entries.find((entry) => entry.key === 'b')?.kind).toBe('ADDED');
  });

  it('reports a removed section', () => {
    const diff = diffDocuments(
      { version: 1, entries: entries({ a: 'One', b: 'Two' }) },
      { version: 2, entries: entries({ a: 'One' }) },
    );

    expect(diff.entries.find((entry) => entry.key === 'b')?.kind).toBe('REMOVED');
  });
});
