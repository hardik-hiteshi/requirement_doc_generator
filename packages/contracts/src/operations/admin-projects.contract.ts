import { z } from 'zod';

import { PROJECT_STATUSES } from '../project/project-status';

/**
 * What an operator may see about one project.
 *
 * Support work starts with a question about a specific project — "they say their
 * upload never finished", "they cannot reach the link they were sent" — and until
 * now the only way to answer it was a database shell on production. That is worse
 * for privacy than a scoped read: a shell sees everything, records nothing, and is
 * available to whoever has the container.
 *
 * ## Metadata only, and the boundary is in the type
 *
 * Every field here is a status, a timestamp or a count. There is no field for
 * requirement text, document content, an exported file, a recovery secret or any
 * stored payload — not redacted, not truncated, *absent*. A support question is
 * answerable from shape: how many sources, what state they reached, when the project
 * expires, whether anything is stuck. It is not answerable by reading the client's
 * commercial documents, and an operator surface that could read them would be a
 * standing invitation to.
 *
 * The schema is `.strict()`, so a future field cannot arrive by accident: adding one
 * means writing it here, where this comment is.
 */

export const adminProjectSummarySchema = z
  .object({
    projectId: z.string().min(1).max(64),
    name: z.string().max(200),
    /** As stored. May lag the derived value — see `effectiveStatus`. */
    status: z.enum(PROJECT_STATUSES),
    /**
     * What the application actually treats the project as right now.
     *
     * Expiry is derived on access, so a record can say `ACTIVE` while every request
     * is refused. Showing both is the point: a support question about "why can't I
     * edit" is answered by the difference between these two fields.
     */
    effectiveStatus: z.enum(PROJECT_STATUSES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastAccessedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    deletionRequestedAt: z.string().datetime().optional(),
  })
  .strict();

export type AdminProjectSummary = z.infer<typeof adminProjectSummarySchema>;

/** Counts, so an operator can see shape without seeing content. */
export const adminProjectDetailSchema = adminProjectSummarySchema
  .extend({
    counts: z
      .object({
        requirementSources: z.number().int().nonnegative(),
        requirementItems: z.number().int().nonnegative(),
        documents: z.number().int().nonnegative(),
        documentVersions: z.number().int().nonnegative(),
        extractionJobs: z.number().int().nonnegative(),
        auditEvents: z.number().int().nonnegative(),
      })
      .strict(),
    /**
     * Extraction jobs that are not finished, by state.
     *
     * The single most useful thing for a support question: a project whose upload
     * "never finished" has a job sitting in `queued` or `running`, and this says so
     * without anyone reading the file.
     */
    unfinishedJobs: z.record(z.string().max(20), z.number().int().nonnegative()),
  })
  .strict();

export type AdminProjectDetail = z.infer<typeof adminProjectDetailSchema>;

export const adminProjectQuerySchema = z
  .object({
    status: z.enum(PROJECT_STATUSES).optional(),
    /**
     * A project id, exact.
     *
     * Deliberately not a name search. Project names are client names, and a
     * substring search over them turns an operator surface into a client directory —
     * useful for support once, useful for reconnaissance always. An operator handling
     * a support request has the id, because that is what the user can read off their
     * own link.
     */
    projectId: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type AdminProjectQuery = z.infer<typeof adminProjectQuerySchema>;

export const adminProjectListSchema = z
  .object({
    projects: z.array(adminProjectSummarySchema).max(100),
    truncated: z.boolean(),
  })
  .strict();

export type AdminProjectList = z.infer<typeof adminProjectListSchema>;

/**
 * Field names a project view must never contain.
 *
 * Asserted by a test against the rendered response rather than trusted to review: the
 * boundary that matters is what actually goes over the wire, and a projection is one
 * careless spread away from carrying everything.
 */
export const FORBIDDEN_PROJECT_VIEW_FIELDS: readonly string[] = [
  'secretHash',
  'secret',
  'recoverySecret',
  'sections',
  'features',
  'rows',
  'payload',
  'body',
  'text',
  'content',
  'blocks',
  'extractedContent',
];
