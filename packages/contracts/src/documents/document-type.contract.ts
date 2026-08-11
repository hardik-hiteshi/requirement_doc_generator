import { z } from 'zod';

/**
 * The seven controlled documents this application produces.
 *
 * All seven are named here, and only two are implemented. That is deliberate:
 * the dependency graph, the outdated propagation and the UI's locked-step list
 * all need to know what exists eventually, and discovering document five while
 * building it is how an engine acquires a special case per document.
 *
 * `IMPLEMENTED_DOCUMENT_TYPES` is the honest half. Nothing outside it can be
 * generated, read, validated or approved — the service refuses, the routes
 * reject, and the UI shows the step as unavailable rather than as a button that
 * fails. A named type is a declared intention, not a feature.
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

/** The documents Phase 7 actually builds. Everything else is declared only. */
export const IMPLEMENTED_DOCUMENT_TYPES = ['OUR_UNDERSTANDING', 'FEATURE_LISTING'] as const;

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
  ACCEPTANCE_CRITERIA: 'How each feature will be judged done.',
  ASSUMPTIONS: 'What this plan takes for granted, stated rather than buried.',
  STATEMENT_OF_WORK: 'The commercial document: scope, deliverables, terms.',
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

export const DOCUMENT_SHAPE_BY_TYPE: Readonly<Record<DocumentType, DocumentShape>> = {
  OUR_UNDERSTANDING: 'SECTIONS',
  FEATURE_LISTING: 'ROWS',
  ACCEPTANCE_CRITERIA: 'ROWS',
  ASSUMPTIONS: 'SECTIONS',
  STATEMENT_OF_WORK: 'SECTIONS',
  WORK_BREAKDOWN_STRUCTURE: 'ROWS',
  CLIENT_DEPENDENCY_SHEET: 'ROWS',
};
