import { z } from 'zod';

import { documentTypeSchema } from './document-type.contract';

/**
 * One document generation, recorded.
 *
 * Sizes, timings, prompt versions and failures — never the requirement text it
 * read, never the prompt it sent, never the prose it produced. The same rule as
 * every run record in this application: an operational record must be safe to
 * read, safe to export and safe to keep, and confidential project content is
 * none of those.
 *
 * `sectionKeys` records *which* sections a run touched, which is what makes a
 * single-section regeneration auditable without storing what it wrote.
 */

export const DOCUMENT_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type DocumentRunStatus = (typeof DOCUMENT_RUN_STATUSES)[number];

/** What a run was for. A regeneration of one section is not a fresh document. */
export const DOCUMENT_RUN_KINDS = [
  'FULL_GENERATION',
  'FULL_REGENERATION',
  'SECTION_REGENERATION',
  'VALIDATION',
] as const;

export type DocumentRunKind = (typeof DOCUMENT_RUN_KINDS)[number];

export const documentRunSchema = z
  .object({
    runId: z.string().min(1).max(64),
    projectId: z.string().min(1).max(64),
    type: documentTypeSchema,
    kind: z.enum(DOCUMENT_RUN_KINDS),
    status: z.enum(DOCUMENT_RUN_STATUSES),

    /** Upstream versions the run read. */
    baselineVersion: z.number().int().nonnegative().optional(),
    stackVersion: z.number().int().nonnegative().optional(),
    estimateVersion: z.number().int().nonnegative().optional(),

    provider: z.string().max(60),
    model: z.string().max(120),
    /** Prompt versions, by task id. */
    promptVersions: z.record(z.string().max(60), z.string().max(20)),
    /** Sections or rows this run wrote. */
    sectionKeys: z.array(z.string().max(64)).max(60),

    /** Characters of evidence sent, and of output received. Sizes, not content. */
    inputCharacters: z.number().int().nonnegative(),
    outputCharacters: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),

    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    /** Machine-readable failure. The message a user sees comes from the code. */
    failureCode: z.string().max(60).optional(),
    /** True when no model was involved at all. */
    deterministicOnly: z.boolean(),
  })
  .strict();

export type DocumentRun = z.infer<typeof documentRunSchema>;

export function isDocumentRunActive(status: DocumentRunStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}
