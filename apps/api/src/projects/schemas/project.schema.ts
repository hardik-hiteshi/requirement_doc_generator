import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PROJECT_STATUSES, type ProjectStatus } from '@wdrg/contracts';
import { HydratedDocument } from 'mongoose';

/**
 * Persisted project.
 *
 * Notes on the shape:
 *
 * - `projectId` is the public identifier and the only one clients ever see. The
 *   Mongo `_id` is never exposed: it is sequential-ish, and treating it as the
 *   public handle would make projects enumerable.
 * - `secretHash` holds a salted scrypt digest. The raw recovery secret is not
 *   stored in any form, so a database leak does not yield working access.
 * - `version` is the optimistic-concurrency counter, incremented by the
 *   repository on every accepted write. It is separate from Mongoose's internal
 *   `__v`, which tracks array-shape changes rather than logical revisions.
 * - `schemaVersion` records which document layout this record was written with,
 *   so a future migration can find the records that need it.
 */

@Schema({ _id: false })
export class SecretHash {
  @Prop({ type: String, required: true }) algorithm!: string;
  @Prop({ type: Number, required: true }) version!: number;
  @Prop({ type: String, required: true }) salt!: string;
  @Prop({ type: String, required: true }) hash!: string;
}

export const SecretHashSchema = SchemaFactory.createForClass(SecretHash);

export type ProjectDocument = HydratedDocument<Project>;

/** Bump when the document layout changes in a way a migration must find. */
export const PROJECT_SCHEMA_VERSION = 1;

@Schema({
  collection: 'projects',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  // The API returns mapped responses, never raw documents; disabling the
  // virtual `id` keeps a stray serialisation from exposing the Mongo `_id`.
  id: false,
  versionKey: false,
})
export class Project {
  @Prop({ type: String, required: true, unique: true, index: true })
  projectId!: string;

  @Prop({ type: SecretHashSchema, required: true, select: false })
  secretHash!: SecretHash;

  // Every `@Prop` states its type explicitly rather than relying on emitted
  // decorator metadata, which differs between compilers for optional
  // properties and does not exist at all for a union of string literals.
  @Prop({ type: String, required: true, enum: PROJECT_STATUSES, index: true })
  status!: ProjectStatus;

  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number, required: true, default: PROJECT_SCHEMA_VERSION })
  schemaVersion!: number;

  /* --------------------------------------------------------------- details */

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, trim: true })
  clientName?: string;

  @Prop({ type: String, trim: true })
  internalReference?: string;

  @Prop({ type: String, trim: true })
  description?: string;

  @Prop({ type: [String], default: undefined })
  projectTypes?: string[];

  /* -------------------------------------------------- planning (Phase 2 in) */

  /**
   * Structured sub-documents are stored as free-form objects and validated by
   * the Zod contract at the boundary. Mirroring the discriminated unions in
   * Mongoose would duplicate the rules and let the two definitions drift; the
   * contract is the single source of truth.
   */
  @Prop({ type: Object })
  timeline?: Record<string, unknown>;

  @Prop({ type: Object })
  startDate?: Record<string, unknown>;

  @Prop({ type: Object })
  teamCapacity?: Record<string, unknown>;

  @Prop({ type: Object })
  outputPreferences?: Record<string, unknown>;

  /**
   * How exports are presented. Presentation only.
   *
   * Beside the output preferences because it answers the same kind of question — what a
   * generated file looks like — and because it must never be mistaken for document
   * authority: changing it cannot move a version or make anything outdated.
   */
  @Prop({ type: Object })
  branding?: Record<string, unknown>;

  /* ------------------------------------------------------------- lifecycle */

  @Prop({ type: Date, required: true, index: true })
  lastAccessedAt!: Date;

  @Prop({ type: Date, required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date })
  deletionRequestedAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;

  /** Set by Mongoose via `timestamps`. */
  createdAt!: Date;
  updatedAt!: Date;
}

export const ProjectSchema = SchemaFactory.createForClass(Project);

/*
 * Indexes.
 *
 * - `projectId` unique: the lookup on every authenticated request, and the
 *   uniqueness guarantee behind the public identifier.
 * - `status + expiresAt`: the query the expiry sweep will run.
 *
 * Deliberately **no TTL index.** A TTL index would delete documents outright on
 * `expiresAt`, which would erase the audit trail's subject and skip the
 * `DELETION_PENDING` state that the lifecycle depends on. Expiry here means
 * "no longer usable", not "gone" — the transition to `DELETED`, and any physical
 * removal, belongs to the retention job in Phase 12 where the rules are defined.
 */
ProjectSchema.index({ projectId: 1 }, { unique: true, name: 'projectId_unique' });
ProjectSchema.index({ status: 1, expiresAt: 1 }, { name: 'status_expiry' });
