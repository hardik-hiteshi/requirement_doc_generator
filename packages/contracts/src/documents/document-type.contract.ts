import { z } from 'zod';

/**
 * The seven controlled documents this application produces.
 *
 * All seven were named here from the first document onwards, while only two were
 * built. That was deliberate: the dependency graph, the outdated propagation and the
 * UI's locked-step list all need to know what exists eventually, and discovering
 * document five while building it is how an engine acquires a special case per
 * document.
 *
 * As of Phase 9 all seven are built, so `IMPLEMENTED_DOCUMENT_TYPES` now lists the
 * same seven. The distinction stays because it is load-bearing — the service, the
 * routes and the screen all gate on it — and because the next document type added to
 * this list will be declared before it works, exactly as these were.
 */
export const DOCUMENT_TYPES = [
  'OUR_UNDERSTANDING',
  'FEATURE_LISTING',
  'ACCEPTANCE_CRITERIA',
  'ASSUMPTIONS',
  'STATEMENT_OF_WORK',
  'WORK_BREAKDOWN_STRUCTURE',
  'CLIENT_DEPENDENCY_SHEET',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);

/**
 * The documents that are actually built.
 *
 * Phase 7 built the first two, Phase 8 the next three, and Phase 9 the Work Breakdown
 * Structure and the Client Dependency Sheet — so this is now the complete seven.
 *
 * The gate itself remains: nothing outside this list can be generated, read,
 * validated or approved, because the service refuses, the routes reject, and the
 * screen shows the step as unavailable rather than as a button that fails. An empty
 * gap between these two lists is the healthy state, not a reason to delete the gate.
 */
export const IMPLEMENTED_DOCUMENT_TYPES = [
  'OUR_UNDERSTANDING',
  'FEATURE_LISTING',
  'ACCEPTANCE_CRITERIA',
  'ASSUMPTIONS',
  'STATEMENT_OF_WORK',
  'WORK_BREAKDOWN_STRUCTURE',
  'CLIENT_DEPENDENCY_SHEET',
] as const;

export type ImplementedDocumentType = (typeof IMPLEMENTED_DOCUMENT_TYPES)[number];

export function isImplementedDocumentType(type: DocumentType): type is ImplementedDocumentType {
  return (IMPLEMENTED_DOCUMENT_TYPES as readonly DocumentType[]).includes(type);
}

/** Presentation order, which is also generation order. */
export const DOCUMENT_ORDER: Readonly<Record<DocumentType, number>> = {
  OUR_UNDERSTANDING: 1,
  FEATURE_LISTING: 2,
  ACCEPTANCE_CRITERIA: 3,
  ASSUMPTIONS: 4,
  STATEMENT_OF_WORK: 5,
  WORK_BREAKDOWN_STRUCTURE: 6,
  CLIENT_DEPENDENCY_SHEET: 7,
};

export const DOCUMENT_LABELS: Readonly<Record<DocumentType, string>> = {
  OUR_UNDERSTANDING: 'Our Understanding',
  FEATURE_LISTING: 'Feature Listing',
  ACCEPTANCE_CRITERIA: 'Acceptance Criteria',
  ASSUMPTIONS: 'Assumptions',
  STATEMENT_OF_WORK: 'Statement of Work',
  WORK_BREAKDOWN_STRUCTURE: 'Work Breakdown Structure',
  CLIENT_DEPENDENCY_SHEET: 'Client Dependency Sheet',
};

export const DOCUMENT_DESCRIPTIONS: Readonly<Record<DocumentType, string>> = {
  OUR_UNDERSTANDING:
    'What we understand you are asking us to build, in your terms, from the requirements you approved.',
  FEATURE_LISTING:
    'Every feature as a row, with the hours from the estimate you approved — module, screen, description and effort.',
  ACCEPTANCE_CRITERIA:
    'The observable conditions for accepting the approved scope — what has to be true, not how it will be tested.',
  ASSUMPTIONS:
    'What this plan is resting on, each one with somebody behind it and what would happen if it were wrong.',
  STATEMENT_OF_WORK:
    'The commercial document: scope, deliverables, technology, timeline and how the work is accepted.',
  WORK_BREAKDOWN_STRUCTURE: 'The plan broken into deliverable work packages.',
  CLIENT_DEPENDENCY_SHEET: 'What we need from you, and by when.',
};

/**
 * Whether a document's content is a body of prose sections or a table of rows.
 *
 * The engine is shared, so the difference has to be data rather than two
 * engines. A `SECTIONS` document is generated, edited and regenerated per
 * section; a `ROWS` document per row.
 */
export const DOCUMENT_SHAPES = ['SECTIONS', 'ROWS'] as const;
export type DocumentShape = (typeof DOCUMENT_SHAPES)[number];

/**
 * Which kind of row a `ROWS` document is a list of.
 *
 * Feature Listing's rows are `FEATURE` and keep their own shape and storage,
 * because they carry authoritative hours reconciled against the approved estimate
 * and a pinned eight-column export. Every other row kind shares the generic row
 * envelope — see `document-row.contract.ts` for why that split is deliberate.
 */
export const DOCUMENT_ROW_KIND_BY_TYPE: Readonly<Partial<Record<DocumentType, string>>> = {
  FEATURE_LISTING: 'FEATURE',
  ACCEPTANCE_CRITERIA: 'ACCEPTANCE_CRITERION',
  ASSUMPTIONS: 'ASSUMPTION',
  WORK_BREAKDOWN_STRUCTURE: 'WORK_PACKAGE',
  CLIENT_DEPENDENCY_SHEET: 'CLIENT_DEPENDENCY',
};

export const DOCUMENT_SHAPE_BY_TYPE: Readonly<Record<DocumentType, DocumentShape>> = {
  OUR_UNDERSTANDING: 'SECTIONS',
  FEATURE_LISTING: 'ROWS',
  ACCEPTANCE_CRITERIA: 'ROWS',
  ASSUMPTIONS: 'ROWS',
  STATEMENT_OF_WORK: 'SECTIONS',
  WORK_BREAKDOWN_STRUCTURE: 'ROWS',
  CLIENT_DEPENDENCY_SHEET: 'ROWS',
};
