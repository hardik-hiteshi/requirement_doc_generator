import {
  type CRITERION_ASPECTS,
  ESTIMATION_ROLE_LABELS,
  ESTIMATION_ROLES,
  FEATURE_CSV_COLUMNS,
  otherRoleEffort,
  otherRolesCell,
  roundHours,
  type DocumentSnapshot,
  type EstimationRole,
  type ProjectDocument,
} from '@wdrg/contracts';

import {
  exportMetadata,
  flag,
  list,
  metadataBlocks,
  number,
  rowPayloads,
  text,
  type Block,
  type CellValue,
  type ProseProjection,
  type TableProjection,
} from './export-projection';

/**
 * One projection per document, per shape.
 *
 * Every function here reads the snapshot it is given and nothing else. None of them look
 * up a requirement, recompute an estimate or decide whether something is approved: the
 * document already settled all of that, and the export's job is to show what it settled.
 *
 * The structured projections are deliberately verbose. A spreadsheet is where the detail
 * belongs, so the columns are the document's own fields in a fixed order — fixed because
 * somebody's import script keys off position, and a reordered column is a broken
 * integration that looks like a working file.
 *
 * The prose projections are deliberately selective. A thirty-column table on a portrait
 * page is not a document anybody reads, so the human-readable forms carry the fields a
 * person needs and leave the rest to the spreadsheet. Selective is not the same as
 * altered: no total is recomputed and no row is dropped.
 */

/* --------------------------------------------------------------- shared bits */

const hours = (value: number | undefined): CellValue =>
  value === undefined || value === 0
    ? { kind: 'empty' }
    : { kind: 'number', value: roundHours(value) };

/** A date cell only when the document holds a real one. Never invented. */
const storedDate = (value: string | undefined): CellValue => {
  if (!value) {
    return { kind: 'empty' };
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? text(value) : { kind: 'date', value: parsed };
};

const asText = (cell: CellValue): string => {
  switch (cell.kind) {
    case 'text':
      return cell.value;
    case 'number':
      return String(cell.value);
    case 'date':
      return cell.value.toISOString().slice(0, 10);
    case 'empty':
      return '';
  }
};

/** Relative timing stays words, so nothing downstream reads it as a date. */
const relativeDays = (from: number | undefined, to: number | undefined): CellValue => {
  if (from === undefined && to === undefined) {
    return { kind: 'empty' };
  }

  if (from !== undefined && to !== undefined) {
    return text(from === to ? `Day ${from}` : `Day ${from} → ${to}`);
  }

  return text(`Day ${from ?? to}`);
};

/* ------------------------------------------------------- Our Understanding */

function understandingProse(snapshot: DocumentSnapshot, blocks: Block[]): ProseProjection {
  for (const section of [...snapshot.sections].sort((a, b) => a.order - b.order)) {
    blocks.push({ kind: 'heading', level: 3, text: section.title });

    if (section.body.trim().length === 0) {
      /*
       * An omitted section says why it is empty, in the words the document already chose.
       * Silence would read as an oversight; invented prose would be worse than either.
       */
      blocks.push({
        kind: 'note',
        text:
          section.omittedReason === ''
            ? 'Nothing in the approved requirements covers this.'
            : section.omittedReason,
      });
      continue;
    }

    for (const paragraph of section.body.split(/\n{2,}/)) {
      const lines = paragraph.split('\n').filter((line) => line.trim().length > 0);

      if (lines.length > 1) {
        blocks.push({ kind: 'bullets', items: lines.map((line) => line.trim()) });
      } else if (lines[0]) {
        blocks.push({ kind: 'paragraph', text: lines[0].trim() });
      }
    }
  }

  return { blocks, landscape: false };
}

/* ---------------------------------------------------------- Feature Listing */

/**
 * The structured Feature Listing, in the frozen eight-column shape.
 *
 * The columns come from `FEATURE_CSV_COLUMNS` rather than being typed out again, so the
 * spreadsheet and the strict CSV cannot drift apart. Hours stay numeric: a client
 * multiplying a column should get the same total the estimate did.
 */
function featureTable(snapshot: DocumentSnapshot): TableProjection {
  return {
    sheetName: 'Feature Listing',
    columns: [
      { header: FEATURE_CSV_COLUMNS[0], width: 24 },
      { header: FEATURE_CSV_COLUMNS[1], width: 24 },
      { header: FEATURE_CSV_COLUMNS[2], width: 24 },
      { header: FEATURE_CSV_COLUMNS[3], width: 60 },
      { header: FEATURE_CSV_COLUMNS[4], width: 16 },
      { header: FEATURE_CSV_COLUMNS[5], width: 16 },
      { header: FEATURE_CSV_COLUMNS[6], width: 16 },
      { header: FEATURE_CSV_COLUMNS[7], width: 28 },
    ],
    rows: snapshot.features.map((feature) => [
      text(feature.module),
      text(feature.submodule),
      text(feature.screen),
      text(feature.description),
      hours(feature.effort.BACKEND),
      hours(feature.effort.FRONTEND),
      hours(feature.effort.QA),
      /* The same cell the strict CSV writes, so the two files agree. */
      text(otherRolesCell(feature)),
    ]),
  };
}

/**
 * The readable Feature Listing: grouped by module, one table per module.
 *
 * Eight columns across a portrait page is unreadable, and landscape alone does not save
 * it once descriptions are long. Grouping turns it into something a person can follow
 * without changing a single figure.
 */
function featureProse(snapshot: DocumentSnapshot, blocks: Block[]): ProseProjection {
  const byModule = new Map<string, typeof snapshot.features>();

  for (const feature of snapshot.features) {
    const key = feature.module === '' ? 'Unassigned' : feature.module;
    byModule.set(key, [...(byModule.get(key) ?? []), feature]);
  }

  if (byModule.size === 0) {
    blocks.push({ kind: 'note', text: 'No features have been listed in this version.' });

    return { blocks, landscape: true };
  }

  for (const [module, features] of byModule) {
    blocks.push({ kind: 'heading', level: 3, text: module });
    blocks.push({
      kind: 'table',
      wide: true,
      columns: ['Sub module', 'Screen', 'Feature', 'Backend', 'Frontend', 'QA', 'Other'],
      rows: features.map((feature) => {
        const otherTotal = otherRoleEffort(feature.effort).reduce(
          (sum, entry) => sum + entry.hours,
          0,
        );

        return [
          feature.submodule,
          feature.screen,
          feature.description,
          asText(hours(feature.effort.BACKEND)),
          asText(hours(feature.effort.FRONTEND)),
          asText(hours(feature.effort.QA)),
          asText(hours(otherTotal)),
        ];
      }),
    });
  }

  return { blocks, landscape: true };
}

/* ------------------------------------------------------- Acceptance Criteria */

interface CriterionPayload {
  readonly criterionKey: string;
  readonly module: string;
  readonly submodule: string;
  readonly screen: string;
  readonly actor: string;
  readonly aspect: (typeof CRITERION_ASPECTS)[number];
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly rule: string;
  readonly status: string;
  readonly requirementIds: readonly string[];
  readonly featureIds: readonly string[];
  readonly notes: string;
}

function criteriaTable(snapshot: DocumentSnapshot): TableProjection {
  const criteria = rowPayloads<CriterionPayload>(snapshot, 'ACCEPTANCE_CRITERION');

  return {
    sheetName: 'Acceptance Criteria',
    columns: [
      { header: 'Criterion ID', width: 14 },
      { header: 'Module', width: 22 },
      { header: 'Sub Module', width: 22 },
      { header: 'Screen', width: 22 },
      { header: 'Actor', width: 18 },
      { header: 'Aspect', width: 16 },
      { header: 'Given', width: 40 },
      { header: 'When', width: 40 },
      { header: 'Then', width: 50 },
      { header: 'Rule', width: 40 },
      { header: 'Requirements', width: 24 },
      { header: 'Features', width: 24 },
      { header: 'Status', width: 14 },
      { header: 'Notes', width: 30 },
    ],
    rows: criteria.map((criterion) => [
      text(criterion.criterionKey),
      text(criterion.module),
      text(criterion.submodule),
      text(criterion.screen),
      text(criterion.actor),
      text(criterion.aspect),
      text(criterion.given),
      text(criterion.when),
      text(criterion.then),
      text(criterion.rule),
      list(criterion.requirementIds),
      list(criterion.featureIds),
      text(criterion.status),
      text(criterion.notes),
    ]),
  };
}

function criteriaProse(snapshot: DocumentSnapshot, blocks: Block[]): ProseProjection {
  const criteria = rowPayloads<CriterionPayload>(snapshot, 'ACCEPTANCE_CRITERION');

  if (criteria.length === 0) {
    blocks.push({
      kind: 'note',
      text: 'No acceptance criteria have been written in this version.',
    });

    return { blocks, landscape: false };
  }

  const byModule = new Map<string, CriterionPayload[]>();

  for (const criterion of criteria) {
    const key = criterion.module === '' ? 'General' : criterion.module;
    byModule.set(key, [...(byModule.get(key) ?? []), criterion]);
  }

  for (const [module, group] of byModule) {
    blocks.push({ kind: 'heading', level: 3, text: module });

    for (const criterion of group) {
      blocks.push({
        kind: 'heading',
        level: 3,
        text: `${criterion.criterionKey} — ${criterion.screen || criterion.submodule || module}`,
      });

      /*
       * Given/When/Then when the criterion has that shape, a sentence when it does not.
       * Forcing every criterion into three clauses invents two of them.
       */
      const clauses: string[] = [];

      if (criterion.given) {
        clauses.push(`Given ${criterion.given}`);
      }

      if (criterion.when) {
        clauses.push(`When ${criterion.when}`);
      }

      clauses.push(`${clauses.length > 0 ? 'Then ' : ''}${criterion.then}`);

      blocks.push(
        clauses.length > 1
          ? { kind: 'bullets', items: clauses }
          : { kind: 'paragraph', text: clauses[0]! },
      );

      if (criterion.rule) {
        blocks.push({ kind: 'paragraph', text: criterion.rule });
      }

      if (criterion.requirementIds.length > 0) {
        blocks.push({
          kind: 'paragraph',
          text: `Traces to ${criterion.requirementIds.join(', ')}.`,
        });
      }
    }
  }

  return { blocks, landscape: false };
}

/* ------------------------------------------------------------- Assumptions */

interface AssumptionPayload {
  readonly assumptionKey: string;
  readonly category: string;
  readonly statement: string;
  readonly provenance: string;
  readonly basis: string;
  readonly status: string;
  readonly impact: string;
  readonly impactAreas: readonly string[];
  readonly impactIfFalse: string;
  readonly validationNeeded: string;
  readonly owner: string;
  readonly requirementIds: readonly string[];
}

/**
 * Only what belongs in the selected version, and only as what it actually is.
 *
 * A model's candidate is not an agreed assumption and a rejected one is not an assumption
 * at all. Both would change the meaning of a document a client reads, so both are left
 * out — and a version with nothing agreed exports as a document that says so, because
 * "we assumed nothing yet" is a true and useful statement, not an error.
 */
function assumptionsProse(snapshot: DocumentSnapshot, blocks: Block[]): ProseProjection {
  const assumptions = rowPayloads<AssumptionPayload>(snapshot, 'ASSUMPTION').filter(
    (assumption) => assumption.status !== 'EXCLUDED' && assumption.status !== 'SUPERSEDED',
  );

  if (assumptions.length === 0) {
    blocks.push({
      kind: 'note',
      text: 'No assumptions have been recorded against this project. Anything not stated in the approved requirements remains to be confirmed.',
    });

    return { blocks, landscape: false };
  }

  const byCategory = new Map<string, AssumptionPayload[]>();

  for (const assumption of assumptions) {
    const key = assumption.category === '' ? 'General' : assumption.category;
    byCategory.set(key, [...(byCategory.get(key) ?? []), assumption]);
  }

  for (const [category, group] of byCategory) {
    blocks.push({ kind: 'heading', level: 3, text: category });

    for (const assumption of group) {
      blocks.push({
        kind: 'paragraph',
        text: `${assumption.assumptionKey}. ${assumption.statement}`,
      });

      const detail = [
        assumption.basis ? `Basis: ${assumption.basis}` : '',
        assumption.impact ? `Impact if untrue: ${assumption.impact}` : '',
        assumption.impactIfFalse,
        assumption.validationNeeded ? `To confirm: ${assumption.validationNeeded}` : '',
        assumption.owner ? `Owner: ${assumption.owner}` : '',
      ].filter((line) => line.length > 0);

      if (detail.length > 0) {
        blocks.push({ kind: 'bullets', items: detail });
      }
    }
  }

  return { blocks, landscape: false };
}

/* --------------------------------------------------------- Statement of Work */

/**
 * The SOW, rendered as it stands.
 *
 * Nothing is added. No payment terms, no warranty, no governing law, no liability — a
 * renderer that invents a clause has put words in somebody's contract, and the document
 * did not agree to them. Sections come out in the order the document holds them.
 */
function statementOfWorkProse(snapshot: DocumentSnapshot, blocks: Block[]): ProseProjection {
  return understandingProse(snapshot, blocks);
}

/* -------------------------------------------------- Work Breakdown Structure */

interface WorkPackagePayload {
  readonly wbsId: string;
  readonly parentId: string;
  readonly sequence: number;
  readonly level: string;
  readonly phase: string;
  readonly module: string;
  readonly submodule: string;
  readonly feature: string;
  readonly task: string;
  readonly description: string;
  readonly workKind: string;
  readonly requirementIds: readonly string[];
  readonly featureIds: readonly string[];
  readonly estimateUnitIds: readonly string[];
  readonly ownerRole: string;
  readonly effort: Readonly<Record<string, number>>;
  readonly totalEffort: number;
  readonly relativeStartDay?: number;
  readonly relativeFinishDay?: number;
  readonly actualStartDate?: string;
  readonly actualFinishDate?: string;
  readonly workingDuration?: number;
  readonly predecessors: readonly string[];
  readonly dependencyType: string;
  readonly parallelizable: boolean;
  readonly onCriticalPath: boolean;
  readonly milestoneId: string;
  readonly deliverable: string;
  readonly uncertainty: string;
  readonly status: string;
  readonly notes: string;
}

const WBS_ROLE_COLUMNS: readonly EstimationRole[] = ESTIMATION_ROLES;

function wbsTable(snapshot: DocumentSnapshot): TableProjection {
  const packages = rowPayloads<WorkPackagePayload>(snapshot, 'WORK_PACKAGE');

  return {
    sheetName: 'Work Breakdown',
    columns: [
      { header: 'WBS ID', width: 14 },
      { header: 'Parent ID', width: 14 },
      { header: 'Sequence', width: 10 },
      { header: 'Level', width: 12 },
      { header: 'Phase', width: 18 },
      { header: 'Module', width: 22 },
      { header: 'Sub Module', width: 22 },
      { header: 'Feature', width: 26 },
      { header: 'Task', width: 34 },
      { header: 'Description', width: 50 },
      { header: 'Work Kind', width: 14 },
      { header: 'Requirements', width: 22 },
      { header: 'Features', width: 22 },
      { header: 'Estimate Units', width: 22 },
      { header: 'Owner Role', width: 18 },
      ...WBS_ROLE_COLUMNS.map((role) => ({ header: ESTIMATION_ROLE_LABELS[role], width: 14 })),
      { header: 'Total Effort', width: 14 },
      { header: 'Relative Schedule', width: 20 },
      { header: 'Actual Start', width: 14 },
      { header: 'Actual Finish', width: 14 },
      { header: 'Working Days', width: 12 },
      { header: 'Predecessors', width: 22 },
      { header: 'Dependency Type', width: 16 },
      { header: 'Parallelizable', width: 14 },
      { header: 'Milestone', width: 18 },
      { header: 'Deliverable', width: 26 },
      { header: 'Critical Path', width: 14 },
      { header: 'Uncertainty', width: 14 },
      { header: 'Status', width: 14 },
      { header: 'Notes', width: 30 },
    ],
    rows: packages.map((item) => [
      text(item.wbsId),
      text(item.parentId),
      number(item.sequence),
      text(item.level),
      text(item.phase),
      text(item.module),
      text(item.submodule),
      text(item.feature),
      text(item.task),
      text(item.description),
      text(item.workKind),
      list(item.requirementIds),
      list(item.featureIds),
      list(item.estimateUnitIds),
      text(
        item.ownerRole
          ? (ESTIMATION_ROLE_LABELS[item.ownerRole as EstimationRole] ?? item.ownerRole)
          : '',
      ),
      ...WBS_ROLE_COLUMNS.map((role) => hours(item.effort[role])),
      hours(item.totalEffort),
      relativeDays(item.relativeStartDay, item.relativeFinishDay),
      storedDate(item.actualStartDate),
      storedDate(item.actualFinishDate),
      number(item.workingDuration),
      list(item.predecessors),
      text(item.dependencyType),
      flag(item.parallelizable),
      text(item.milestoneId),
      text(item.deliverable),
      flag(item.onCriticalPath),
      text(item.uncertainty),
      text(item.status),
      text(item.notes),
    ]),
  };
}

/** The planning read: hierarchy, ownership, effort, timing and what waits on what. */
function wbsProse(snapshot: DocumentSnapshot, blocks: Block[]): ProseProjection {
  const packages = rowPayloads<WorkPackagePayload>(snapshot, 'WORK_PACKAGE');

  if (packages.length === 0) {
    blocks.push({ kind: 'note', text: 'No work packages have been planned in this version.' });

    return { blocks, landscape: true };
  }

  const byPhase = new Map<string, WorkPackagePayload[]>();

  for (const item of packages) {
    const key = item.phase === '' ? 'Delivery' : item.phase;
    byPhase.set(key, [...(byPhase.get(key) ?? []), item]);
  }

  for (const [phase, group] of byPhase) {
    blocks.push({ kind: 'heading', level: 3, text: phase });
    blocks.push({
      kind: 'table',
      wide: true,
      columns: ['WBS', 'Task', 'Owner', 'Effort', 'Timing', 'Waits on', 'Milestone', 'Critical'],
      rows: group.map((item) => [
        item.wbsId,
        item.task,
        item.ownerRole
          ? (ESTIMATION_ROLE_LABELS[item.ownerRole as EstimationRole] ?? item.ownerRole)
          : '',
        asText(hours(item.totalEffort)),
        asText(relativeDays(item.relativeStartDay, item.relativeFinishDay)),
        item.predecessors.join('; '),
        item.milestoneId,
        item.onCriticalPath ? 'Yes' : '',
      ]),
    });
  }

  /* The totals the document already computed, restated rather than recalculated. */
  const total = packages.reduce((sum, item) => sum + item.totalEffort, 0);

  blocks.push({ kind: 'paragraph', text: `Total planned effort: ${roundHours(total)} hours.` });

  return { blocks, landscape: true };
}

/* ---------------------------------------------------- Client Dependency Sheet */

interface DependencyPayload {
  readonly dependencyKey: string;
  readonly category: string;
  readonly module: string;
  readonly feature: string;
  readonly dependency: string;
  readonly description: string;
  readonly purpose: string;
  readonly requirementIds: readonly string[];
  readonly featureIds: readonly string[];
  readonly wbsIds: readonly string[];
  readonly clientOwner: string;
  readonly internalOwner: string;
  readonly requiredForMilestoneId: string;
  readonly relativeDue: string;
  readonly actualDueDate?: string;
  readonly priority: string;
  readonly blocking: boolean;
  readonly impactIfDelayed: string;
  readonly expectedFormat: string;
  readonly status: string;
  readonly requestedAt?: string;
  readonly receivedAt?: string;
  readonly validationNote: string;
  readonly remarks: string;
}

function dependencyTable(snapshot: DocumentSnapshot): TableProjection {
  const dependencies = rowPayloads<DependencyPayload>(snapshot, 'CLIENT_DEPENDENCY');

  return {
    sheetName: 'Client Dependencies',
    columns: [
      { header: 'Dependency ID', width: 16 },
      { header: 'Category', width: 18 },
      { header: 'Module', width: 22 },
      { header: 'Feature', width: 26 },
      { header: 'Client Dependency', width: 34 },
      { header: 'Detailed Description', width: 50 },
      { header: 'Purpose', width: 34 },
      { header: 'Related Requirement IDs', width: 24 },
      { header: 'Related Feature IDs', width: 24 },
      { header: 'Related WBS IDs', width: 24 },
      { header: 'Client Owner', width: 20 },
      { header: 'Internal Owner', width: 20 },
      { header: 'Required Phase/Milestone', width: 22 },
      { header: 'Actual Due Date', width: 16 },
      { header: 'Relative Due', width: 20 },
      { header: 'Priority', width: 12 },
      { header: 'Blocking', width: 10 },
      { header: 'Impact If Delayed', width: 34 },
      { header: 'Source', width: 18 },
      { header: 'Expected Format', width: 20 },
      { header: 'Status', width: 14 },
      { header: 'Requested Date', width: 16 },
      { header: 'Received Date', width: 16 },
      { header: 'Validation State', width: 20 },
      { header: 'Remarks', width: 30 },
    ],
    rows: dependencies.map((item) => [
      text(item.dependencyKey),
      text(item.category),
      text(item.module),
      text(item.feature),
      text(item.dependency),
      text(item.description),
      text(item.purpose),
      list(item.requirementIds),
      list(item.featureIds),
      list(item.wbsIds),
      text(item.clientOwner),
      text(item.internalOwner),
      text(item.requiredForMilestoneId),
      storedDate(item.actualDueDate),
      text(item.relativeDue),
      text(item.priority),
      flag(item.blocking),
      text(item.impactIfDelayed),
      text(item.category),
      text(item.expectedFormat),
      text(item.status),
      storedDate(item.requestedAt),
      storedDate(item.receivedAt),
      text(item.validationNote),
      text(item.remarks),
    ]),
  };
}

function dependencyProse(snapshot: DocumentSnapshot, blocks: Block[]): ProseProjection {
  const dependencies = rowPayloads<DependencyPayload>(snapshot, 'CLIENT_DEPENDENCY');

  if (dependencies.length === 0) {
    blocks.push({ kind: 'note', text: 'Nothing is currently needed from the client.' });

    return { blocks, landscape: false };
  }

  blocks.push({
    kind: 'paragraph',
    text: 'The following are needed from your side. Where an owner or a date is blank, it has not been agreed yet.',
  });

  for (const item of dependencies) {
    blocks.push({ kind: 'heading', level: 3, text: `${item.dependencyKey} — ${item.dependency}` });

    const detail = [
      item.description,
      item.purpose ? `Needed for: ${item.purpose}` : '',
      item.relativeDue ? `When: ${item.relativeDue}` : '',
      item.actualDueDate ? `Due: ${item.actualDueDate.slice(0, 10)}` : '',
      item.clientOwner ? `Your owner: ${item.clientOwner}` : '',
      item.expectedFormat ? `Expected format: ${item.expectedFormat}` : '',
      `Status: ${item.status}`,
      item.blocking
        ? `Blocking: ${item.impactIfDelayed || 'work cannot proceed without this'}`
        : '',
    ].filter((line) => line.length > 0);

    blocks.push({ kind: 'bullets', items: detail });
  }

  return { blocks, landscape: false };
}

/* ------------------------------------------------------------- entry points */

/** Which documents have a structured projection at all. */
export function tableProjection(
  document: ProjectDocument,
  snapshot: DocumentSnapshot,
): TableProjection {
  switch (document) {
    case 'FEATURE_LISTING':
      return featureTable(snapshot);
    case 'ACCEPTANCE_CRITERIA':
      return criteriaTable(snapshot);
    case 'WORK_BREAKDOWN_STRUCTURE':
      return wbsTable(snapshot);
    case 'CLIENT_DEPENDENCY_SHEET':
      return dependencyTable(snapshot);
    default:
      /* The matrix refuses these long before here; this keeps the switch honest. */
      throw new Error(`${document} has no structured projection.`);
  }
}

export function proseProjection(input: {
  readonly document: ProjectDocument;
  readonly snapshot: DocumentSnapshot;
  readonly projectName: string;
  readonly branding: Parameters<typeof exportMetadata>[0]['branding'];
  readonly exportedAt: Date;
}): ProseProjection {
  const metadata = exportMetadata({
    snapshot: input.snapshot,
    document: input.document,
    projectName: input.projectName,
    branding: input.branding,
    exportedAt: input.exportedAt,
  });

  const blocks: Block[] = [...metadataBlocks(metadata)];

  switch (input.document) {
    case 'OUR_UNDERSTANDING':
      return understandingProse(input.snapshot, blocks);
    case 'STATEMENT_OF_WORK':
      return statementOfWorkProse(input.snapshot, blocks);
    case 'FEATURE_LISTING':
      return featureProse(input.snapshot, blocks);
    case 'ACCEPTANCE_CRITERIA':
      return criteriaProse(input.snapshot, blocks);
    case 'ASSUMPTIONS':
      return assumptionsProse(input.snapshot, blocks);
    case 'WORK_BREAKDOWN_STRUCTURE':
      return wbsProse(input.snapshot, blocks);
    case 'CLIENT_DEPENDENCY_SHEET':
      return dependencyProse(input.snapshot, blocks);
  }
}
