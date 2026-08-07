import { z } from 'zod';

import { PROJECT_TYPES } from '../project/project-type.contract';
import { technologyCategorySchema } from './technology-category.contract';
import { costPostureSchema } from './technology-catalog.contract';
import { selectionSourceSchema, stackAuthorityLevelSchema } from './stack-authority.contract';

/**
 * What a locked stack promises to every phase after this one.
 *
 * Written now, before anything consumes it, because the failure it prevents is
 * a slow one. Phase 6 prices work; Phases 7–9 write documents a client signs.
 * If any of them can reach for a technology the locked stack does not name — a
 * "sensible default" for a category left empty, a substitution because a model
 * preferred something else — then the estimate and the Statement of Work
 * describe a system nobody approved, and the divergence surfaces at delivery.
 *
 * So the authority is a record rather than a convention. A locked snapshot
 * emits one of these; downstream phases read it and nothing else; and
 * `isAuthoritative` is the single check that says whether they may proceed.
 *
 * ## The rule, stated once
 *
 * **No phase after this one substitutes a technology.** Not to fill a gap, not
 * to resolve an inconsistency, not on a model's advice. A gap in a locked stack
 * is a gap in the plan, and the answer is to reopen the stack — which is an
 * explicit act, by a person, that supersedes the snapshot and marks everything
 * built on it out of date.
 */

export const DOWNSTREAM_AUTHORITY_VERSION = 1;

/** One technology, as a later phase sees it. Flat, minimal, immutable. */
export const authoritativeTechnologySchema = z
  .object({
    category: technologyCategorySchema,
    technologyId: z.string().max(64).optional(),
    technologyName: z.string().min(1).max(120),
    /** Absent unless a version was actually pinned. Never "latest". */
    version: z.string().max(30).optional(),
    authority: stackAuthorityLevelSchema,
    selectionSource: selectionSourceSchema.optional(),
    /** A requirement mandates it, so it is a constraint rather than a choice. */
    mandatory: z.boolean(),
    licence: z.string().max(60),
    costPosture: costPostureSchema,
    selfHostable: z.boolean(),
    /** Approved requirement ids behind it, for traceability in the documents. */
    requirementIds: z.array(z.string().max(64)).max(30),
  })
  .strict();

export type AuthoritativeTechnology = z.infer<typeof authoritativeTechnologySchema>;

/**
 * The contract a locked stack hands downstream.
 *
 * `stackSnapshotId` and `stackVersion` are what a later artefact records so it
 * can be checked against the stack it claims to be built on. An estimate citing
 * stack v2 while the project has moved to v3 is detectably stale, which is the
 * whole point of carrying them.
 */
export const downstreamAuthoritySchema = z
  .object({
    contractVersion: z.number().int().positive(),
    projectId: z.string().min(1).max(64),
    stackSnapshotId: z.string().min(1).max(64),
    stackVersion: z.number().int().positive(),
    lockedAt: z.iso.datetime(),
    /** The approved baseline the stack was decided against. */
    baselineId: z.string().min(1).max(64),
    baselineVersion: z.number().int().positive(),
    projectTypes: z.array(z.enum(PROJECT_TYPES)).max(8),
    technologies: z.array(authoritativeTechnologySchema).max(80),
    /** Categories deliberately left empty, and why. Not gaps to be filled. */
    excludedCategories: z
      .array(
        z
          .object({
            category: technologyCategorySchema,
            reason: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(40),
    /**
     * Risks the user acknowledged and kept.
     *
     * Carried downstream on purpose: a Statement of Work that omits a known
     * risk the client accepted is not a record of what was agreed.
     */
    acknowledgedRisks: z
      .array(
        z
          .object({
            summary: z.string().min(1).max(400),
            technologyName: z.string().min(1).max(120),
            note: z.string().max(1000),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

export type DownstreamAuthority = z.infer<typeof downstreamAuthoritySchema>;

/**
 * Whether a later phase may build on this.
 *
 * The only gate. A phase that finds this false stops and says the stack must be
 * locked first, rather than proceeding on a draft.
 */
export function isAuthoritative(
  authority: Pick<DownstreamAuthority, 'contractVersion' | 'technologies'>,
): boolean {
  return (
    authority.contractVersion === DOWNSTREAM_AUTHORITY_VERSION && authority.technologies.length > 0
  );
}

/**
 * Look up the technology in a category, for a later phase.
 *
 * Returns nothing for an empty category, and that is a complete answer — a
 * caller must treat "no cache was chosen" as "there is no cache", never as
 * "pick one". There is deliberately no defaulting parameter.
 */
export function technologyFor(
  authority: DownstreamAuthority,
  category: AuthoritativeTechnology['category'],
): readonly AuthoritativeTechnology[] {
  return authority.technologies.filter((technology) => technology.category === category);
}

/** The sentence a downstream phase shows when the stack is not yet locked. */
export const STACK_NOT_LOCKED_MESSAGE =
  'The technology stack has not been locked yet. Later phases build on the locked stack, so nothing can be estimated or written until it is.';
