import { z } from 'zod';

/**
 * Which file formats the user wants each of the seven documents exported in.
 *
 * The permitted formats differ per document because they follow the document's
 * structure, not preference: a Work Breakdown Structure is tabular and belongs
 * in a spreadsheet, while "Our Understanding" is prose and does not. Offering
 * CSV for prose would produce a file nobody can use.
 *
 * **No export is generated in this phase.** These are stored preferences only;
 * the export engine arrives in Phase 11.
 */
export const EXPORT_FORMATS = ['DOCX', 'PDF', 'CSV', 'XLSX'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const PROJECT_DOCUMENTS = [
  'OUR_UNDERSTANDING',
  'FEATURE_LISTING',
  'ACCEPTANCE_CRITERIA',
  'ASSUMPTIONS',
  'STATEMENT_OF_WORK',
  'WORK_BREAKDOWN_STRUCTURE',
  'CLIENT_DEPENDENCY_SHEET',
] as const;

export type ProjectDocument = (typeof PROJECT_DOCUMENTS)[number];

export const PROJECT_DOCUMENT_LABELS: Readonly<Record<ProjectDocument, string>> = {
  OUR_UNDERSTANDING: 'Our Understanding',
  FEATURE_LISTING: 'Feature Listing',
  ACCEPTANCE_CRITERIA: 'Acceptance Criteria',
  ASSUMPTIONS: 'Assumptions',
  STATEMENT_OF_WORK: 'Statement of Work',
  WORK_BREAKDOWN_STRUCTURE: 'Work Breakdown Structure',
  CLIENT_DEPENDENCY_SHEET: 'Client Dependency Sheet',
};

/** Generation order. The next document unlocks only once this one is approved. */
export const PROJECT_DOCUMENT_ORDER: Readonly<Record<ProjectDocument, number>> = {
  OUR_UNDERSTANDING: 1,
  FEATURE_LISTING: 2,
  ACCEPTANCE_CRITERIA: 3,
  ASSUMPTIONS: 4,
  STATEMENT_OF_WORK: 5,
  WORK_BREAKDOWN_STRUCTURE: 6,
  CLIENT_DEPENDENCY_SHEET: 7,
};

/** The authoritative format matrix. */
export const ALLOWED_FORMATS: Readonly<Record<ProjectDocument, readonly ExportFormat[]>> = {
  OUR_UNDERSTANDING: ['DOCX', 'PDF'],
  FEATURE_LISTING: ['CSV', 'XLSX', 'DOCX', 'PDF'],
  ACCEPTANCE_CRITERIA: ['DOCX', 'PDF', 'XLSX'],
  ASSUMPTIONS: ['DOCX', 'PDF'],
  STATEMENT_OF_WORK: ['DOCX', 'PDF'],
  WORK_BREAKDOWN_STRUCTURE: ['XLSX', 'CSV', 'DOCX', 'PDF'],
  CLIENT_DEPENDENCY_SHEET: ['XLSX', 'CSV', 'DOCX', 'PDF'],
};

export function isFormatAllowed(document: ProjectDocument, format: ExportFormat): boolean {
  return ALLOWED_FORMATS[document].includes(format);
}

/**
 * A per-document format selection.
 *
 * Validated against the matrix rather than accepting any format and filtering
 * later, so an unsupported choice is reported to the user at the point they make
 * it instead of failing at export time, several phases away.
 */
export const outputPreferencesSchema = z
  // `partialRecord`: a user may set preferences for one document without having
  // to state a selection for all seven.
  .partialRecord(z.enum(PROJECT_DOCUMENTS), z.array(z.enum(EXPORT_FORMATS)).min(1).max(4))
  .superRefine((preferences, ctx) => {
    for (const [document, formats] of Object.entries(preferences) as [
      ProjectDocument,
      ExportFormat[] | undefined,
    ][]) {
      if (!formats) {
        continue;
      }

      if (new Set(formats).size !== formats.length) {
        ctx.addIssue({
          code: 'custom',
          path: [document],
          message: 'Each format may be selected only once.',
        });
      }

      for (const format of formats) {
        if (!isFormatAllowed(document, format)) {
          ctx.addIssue({
            code: 'custom',
            path: [document],
            message: `${format} is not available for ${PROJECT_DOCUMENT_LABELS[document]}. Allowed: ${ALLOWED_FORMATS[
              document
            ].join(', ')}.`,
          });
        }
      }
    }
  });

export type OutputPreferences = z.infer<typeof outputPreferencesSchema>;

export const updateOutputPreferencesRequestSchema = z.object({
  outputPreferences: outputPreferencesSchema,
  version: z.number().int().nonnegative(),
});

export type UpdateOutputPreferencesRequest = z.infer<typeof updateOutputPreferencesRequestSchema>;

/** Sensible starting selection: the format each document is most usable in. */
export const DEFAULT_OUTPUT_PREFERENCES: OutputPreferences = {
  OUR_UNDERSTANDING: ['DOCX'],
  FEATURE_LISTING: ['XLSX'],
  ACCEPTANCE_CRITERIA: ['DOCX'],
  ASSUMPTIONS: ['DOCX'],
  STATEMENT_OF_WORK: ['DOCX'],
  WORK_BREAKDOWN_STRUCTURE: ['XLSX'],
  CLIENT_DEPENDENCY_SHEET: ['XLSX'],
};
