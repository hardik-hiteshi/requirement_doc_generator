import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { REVIEW_STATUSES, SOURCE_STATUSES } from '@wdrg/contracts';
import { HydratedDocument } from 'mongoose';

export type RequirementSourceDocument = HydratedDocument<RequirementSourceRecord>;

export const REQUIREMENT_SOURCE_SCHEMA_VERSION = 1;

/**
 * A requirement source: pasted text or an uploaded file.
 *
 * ## Why extracted content lives in its own collection
 *
 * A 500-page PDF produces tens of thousands of blocks. Embedding them here would
 * push a source document towards MongoDB's 16 MB limit, and — long before that —
 * would make *listing* a project's sources load every block of every one of
 * them, because a projection cannot exclude what it has to read off disk first.
 * The list view is the most frequent query in this phase. It must stay cheap.
 *
 * So this collection holds the lifecycle, and `extracted_content` holds the
 * blocks, one document per revision.
 *
 * ## Why revisions are documents rather than an array
 *
 * The same reason, plus one more: a correction is an append, and appending to a
 * subdocument array rewrites the whole array. Separate documents make a
 * correction a single insert, and make "the original extraction" a permanent,
 * immutable document that a restore reads rather than reconstructs.
 */
@Schema({
  collection: 'requirement_sources',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class RequirementSourceRecord {
  // Every @Prop states its type explicitly rather than relying on emitted
  // decorator metadata, which differs between compilers for optional properties
  // and does not exist at all for a union of string literals.
  @Prop({ type: String, required: true, unique: true, index: true })
  sourceId!: string;

  /** The owning project's public id. Every query is scoped by this. */
  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: ['PASTED_TEXT', 'FILE'] })
  kind!: 'PASTED_TEXT' | 'FILE';

  @Prop({ type: String, required: true, enum: SOURCE_STATUSES, index: true })
  status!: (typeof SOURCE_STATUSES)[number];

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: String, required: true, enum: REVIEW_STATUSES, default: 'NOT_REVIEWED' })
  reviewStatus!: (typeof REVIEW_STATUSES)[number];

  @Prop({ type: Date })
  reviewedAt?: Date;

  /* ------------------------------------------------------------ pasted text */

  /**
   * Pasted requirement text.
   *
   * Held on the source rather than in the content collection because it *is* the
   * source — there is no file to go back to, so losing this would lose the
   * evidence itself.
   */
  @Prop({ type: String })
  text?: string;

  /* ------------------------------------------------------------------ file */

  @Prop({ type: String })
  originalFilename?: string;

  @Prop({ type: String })
  displayFilename?: string;

  @Prop({ type: String })
  extension?: string;

  @Prop({ type: String })
  declaredMimeType?: string;

  @Prop({ type: String })
  detectedMimeType?: string;

  @Prop({ type: Number })
  sizeBytes?: number;

  /** Also the duplicate-detection key, within a project. */
  @Prop({ type: String, index: true })
  checksumSha256?: string;

  /**
   * Storage address. **Never returned by any endpoint.**
   *
   * It is an internal address, not a credential and not a thing a client needs.
   * Downloads go through an API route that checks the session, so exposing this
   * would only create a second, weaker way to name a file.
   */
  @Prop({ type: String })
  storageObjectId?: string;

  @Prop({ type: String, enum: ['PENDING', 'PASSED', 'REJECTED'] })
  validationResult?: string;

  @Prop({ type: String, enum: ['NOT_SCANNED', 'CLEAN', 'INFECTED', 'UNAVAILABLE'] })
  malwareScanResult?: string;

  /** Set when this file's checksum already existed in the project. */
  @Prop({ type: String })
  duplicateOf?: string;

  /** Set when the file arrived as .doc or .xls and was converted. */
  @Prop({ type: String })
  convertedFrom?: string;

  /* --------------------------------------------------------------- content */

  /** Which revision `effectiveContent` points at. 0 is the original. */
  @Prop({ type: Number, required: true, default: 0 })
  currentRevision!: number;

  @Prop({ type: Number, required: true, default: 0 })
  revisionCount!: number;

  /** Cached counters, so a list does not have to open the content documents. */
  @Prop({ type: Number })
  blockCount?: number;

  @Prop({ type: Number })
  warningCount?: number;

  @Prop({ type: Number })
  lowConfidenceBlockCount?: number;

  @Prop({ type: Number })
  minimumConfidence?: number;

  @Prop({ type: Boolean })
  usedOcr?: boolean;

  /**
   * Text in this source that reads like an instruction.
   *
   * Advisory, and shown to the user. It changes nothing about how the content is
   * stored or treated — see `evidence-boundary.ts` for why detection is not the
   * control.
   */
  @Prop({ type: [String], default: undefined })
  injectionSignals?: string[];

  /* --------------------------------------------------------------- failure */

  @Prop({ type: String })
  failureCode?: string;

  @Prop({ type: String })
  failureMessage?: string;

  @Prop({ type: Number, required: true, default: 0 })
  retryCount!: number;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Number, required: true, default: REQUIREMENT_SOURCE_SCHEMA_VERSION })
  schemaVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RequirementSourceSchema = SchemaFactory.createForClass(RequirementSourceRecord);

/*
 * The list query is "every live source in this project, newest first" — the most
 * frequent read in the phase, and the one the workspace polls.
 */
RequirementSourceSchema.index({ projectId: 1, createdAt: -1 }, { name: 'project_sources' });

/*
 * Duplicate detection is a lookup by (project, checksum).
 *
 * Deliberately NOT unique. A user may have a documented reason to keep two
 * copies of the same bytes — the same annexe attached under two names, say — and
 * a unique index would make that impossible rather than merely warned about. It
 * is also scoped to the project: a global index would let one project's upload
 * reveal whether another project holds the same file.
 */
RequirementSourceSchema.index({ projectId: 1, checksumSha256: 1 }, { name: 'project_checksum' });

/* The worker's sweep, and the retention job's, both filter on status. */
RequirementSourceSchema.index({ projectId: 1, status: 1 }, { name: 'project_status' });
