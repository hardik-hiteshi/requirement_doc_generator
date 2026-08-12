import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  CORRECTION_OUTCOMES,
  CORRECTION_TARGET_KINDS,
  DOCUMENT_CHANGE_TYPES,
  DOCUMENT_ROW_KINDS,
  DOCUMENT_RUN_KINDS,
  DOCUMENT_RUN_STATUSES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  FEATURE_REVIEW_STATUSES,
  ROW_ORIGINS,
  SECTION_ORIGINS,
  VALIDATION_SEVERITIES,
} from '@wdrg/contracts';
import { HydratedDocument } from 'mongoose';

/**
 * Phase 7's collections.
 *
 * Five, and the split is the same reasoning as every phase before it — with one
 * rule that is specific to documents.
 *
 * **A document is never embedded in the project record.** Seven documents, each
 * with fifteen sections of prose and up to two thousand feature rows, would take
 * a project document past every sensible size and make every unrelated project
 * read expensive. `documents` holds the current state; the content lives beside
 * it.
 *
 * **A section is its own document.** Editing one paragraph is a small write with
 * its own optimistic concurrency, so a person working down a document does not
 * collide with themselves — and a single-section regeneration touches one row.
 *
 * **A feature row is its own document**, for the same reason and more so: two
 * thousand rows in one array is a document nobody can update cheaply.
 *
 * **A version is immutable.** It records the content *as it stood*, so an
 * approved document keeps saying what it said when it was approved, whatever
 * happens afterwards. Restoring copies forward rather than mutating history.
 *
 * **A run is a record, not a result.** Sizes, timings, prompt versions and
 * failures — never the requirement text it read, never the prompt, never the
 * prose.
 *
 * Every collection is indexed on `projectId` first, and every query in this phase
 * is scoped to one project by a verified session.
 */

export const DOCUMENT_STORAGE_VERSION = 1;

/* -------------------------------------------------------------- documents */

@Schema({
  collection: 'documents',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class DocumentRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  documentId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, required: true, enum: DOCUMENT_STATUSES, index: true })
  status!: string;

  @Prop({ type: String, required: true })
  title!: string;

  /* Upstream authority as it stood when the content was written. */

  @Prop({ type: String, required: false })
  baselineId?: string;

  @Prop({ type: Number, required: false })
  baselineVersion?: number;

  @Prop({ type: String, required: false })
  stackSnapshotId?: string;

  @Prop({ type: Number, required: false })
  stackVersion?: number;

  @Prop({ type: String, required: false })
  estimateSnapshotId?: string;

  @Prop({ type: Number, required: false })
  estimateVersion?: number;

  /** Prerequisite document versions, by type. */
  @Prop({ type: Object, required: true, default: {} })
  prerequisiteVersions!: Record<string, number>;

  /* Assessment, recomputed on read and stored so approval can read it. */

  @Prop({ type: Object, required: false, default: null })
  validation!: Record<string, unknown> | null;

  @Prop({ type: [Object], required: true, default: [] })
  blockers!: Record<string, unknown>[];

  @Prop({ type: [Object], required: true, default: [] })
  outdatedReasons!: Record<string, unknown>[];

  @Prop({ type: Object, required: false, default: null })
  coverage!: Record<string, unknown> | null;

  @Prop({ type: Object, required: false, default: null })
  reconciliation!: Record<string, unknown> | null;

  /**
   * Requirements a person deliberately left out of this document.
   *
   * A disposition, not an absence — coverage counts these as handled, which is
   * why the reason is stored with the id rather than separately.
   */
  @Prop({ type: [Object], required: true, default: [] })
  exclusions!: { requirementId: string; reason: string; excludedAt: Date }[];

  /* Provenance. */

  @Prop({ type: Object, required: false, default: null })
  generator!: Record<string, unknown> | null;

  // Not `required`: Mongoose treats '' as absent for a required String, so an
  // empty reason would be rejected rather than stored. Phase 5 learned this.
  @Prop({ type: String, required: false, default: '' })
  regenerationReason!: string;

  @Prop({ type: Number, required: false })
  supersedesVersion?: number;

  @Prop({ type: Number, required: true, default: DOCUMENT_STORAGE_VERSION })
  schemaVersion!: number;

  @Prop({ type: Date, required: false })
  approvedAt?: Date;

  @Prop({ type: Date, required: false })
  finalAt?: Date;

  /** Optimistic concurrency for every write against this document. */
  @Prop({ type: Number, required: true, default: 0 })
  recordVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DocumentDocument = HydratedDocument<DocumentRecord>;
export const DocumentSchema = SchemaFactory.createForClass(DocumentRecord);
DocumentSchema.index({ projectId: 1, type: 1 }, { unique: true });

/* --------------------------------------------------------------- sections */

@Schema({
  collection: 'document_sections',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class DocumentSectionRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  sectionId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  /** Which document version this section belongs to. */
  @Prop({ type: Number, required: true, index: true })
  documentVersion!: number;

  @Prop({ type: String, required: true })
  key!: string;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: Number, required: true })
  order!: number;

  @Prop({ type: String, required: false, default: '' })
  body!: string;

  @Prop({ type: String, required: true, enum: SECTION_ORIGINS })
  origin!: string;

  @Prop({ type: String, required: false, default: '' })
  omittedReason!: string;

  @Prop({ type: [Object], required: true, default: [] })
  references!: Record<string, unknown>[];

  /** A pending replacement for a protected section. */
  @Prop({ type: String, required: false, default: '' })
  proposedBody!: string;

  @Prop({ type: Date, required: false })
  proposedAt?: Date;

  @Prop({ type: String, required: false, default: '' })
  regenerationReason!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DocumentSectionDocument = HydratedDocument<DocumentSectionRecord>;
export const DocumentSectionSchema = SchemaFactory.createForClass(DocumentSectionRecord);
DocumentSectionSchema.index({ projectId: 1, type: 1, documentVersion: 1, order: 1 });

/* --------------------------------------------------------------- features */

@Schema({
  collection: 'document_features',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class DocumentFeatureRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  featureId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  @Prop({ type: Number, required: true, index: true })
  documentVersion!: number;

  @Prop({ type: [String], required: true, default: [] })
  requirementIds!: string[];

  @Prop({ type: String, required: true })
  module!: string;

  @Prop({ type: String, required: false, default: '' })
  submodule!: string;

  /** Legitimately empty for work with no interface. */
  @Prop({ type: String, required: false, default: '' })
  screen!: string;

  @Prop({ type: String, required: true })
  description!: string;

  /** Hours per role, copied from the approved estimate. Never edited here. */
  @Prop({ type: Object, required: true, default: {} })
  effort!: Record<string, number>;

  @Prop({ type: Number, required: true, default: 0 })
  totalHours!: number;

  @Prop({ type: [String], required: true, default: [] })
  estimateUnitIds!: string[];

  @Prop({ type: [String], required: true, default: [] })
  technologyIds!: string[];

  @Prop({ type: [Object], required: true, default: [] })
  references!: Record<string, unknown>[];

  @Prop({ type: String, required: true, enum: FEATURE_REVIEW_STATUSES })
  reviewStatus!: string;

  @Prop({ type: Number, required: true, default: 0 })
  mappingConfidence!: number;

  @Prop({ type: String, required: false, default: '' })
  notes!: string;

  @Prop({ type: Number, required: true, default: 0 })
  order!: number;

  /**
   * A suggested rewrite of the descriptive fields, waiting for a decision.
   *
   * Descriptive only. There is deliberately no proposed effort: hours come from
   * the approved estimate, and a document has nothing to propose about them.
   */
  @Prop({ type: Object, required: false, default: null })
  proposed!: Record<string, string> | null;

  @Prop({ type: Date, required: false })
  proposedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DocumentFeatureDocument = HydratedDocument<DocumentFeatureRecord>;
export const DocumentFeatureSchema = SchemaFactory.createForClass(DocumentFeatureRecord);
DocumentFeatureSchema.index({ projectId: 1, type: 1, documentVersion: 1, order: 1 });

/* --------------------------------------------------------------- versions */

/**
 * An earlier version, whole and immutable.
 *
 * Content is embedded here rather than referenced, deliberately: a version must
 * be readable exactly as it was, and pointing at rows that later moved would
 * make history depend on the present. This is the one place a document's content
 * is denormalised, and it is the place where that is the correct answer.
 */
@Schema({
  collection: 'document_versions',
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  id: false,
  versionKey: false,
})
export class DocumentVersionRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  versionId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, required: true, enum: DOCUMENT_STATUSES })
  status!: string;

  @Prop({ type: Number, required: false })
  baselineVersion?: number;

  @Prop({ type: Number, required: false })
  stackVersion?: number;

  @Prop({ type: Number, required: false })
  estimateVersion?: number;

  @Prop({ type: [Object], required: true, default: [] })
  sections!: Record<string, unknown>[];

  @Prop({ type: [Object], required: true, default: [] })
  features!: Record<string, unknown>[];

  /** Structured rows, for a list document that uses the generic row channel. */
  @Prop({ type: [Object], required: true, default: [] })
  rows!: Record<string, unknown>[];

  @Prop({ type: Object, required: false, default: null })
  validation!: Record<string, unknown> | null;

  @Prop({ type: String, required: false, default: '' })
  regenerationReason!: string;

  @Prop({ type: Date, required: false })
  approvedAt?: Date;

  @Prop({ type: Date, required: false })
  finalAt?: Date;

  /*
   * Why this version exists, recorded at the moment it was cut.
   *
   * Not inferred later from what differs: "this row's wording changed" and "this came
   * back from version 4 and the wording happens to differ" produce the same diff and
   * are different events. A history that cannot tell them apart is a list of numbers.
   */
  @Prop({ type: String, required: false, enum: DOCUMENT_CHANGE_TYPES })
  changeType?: string;

  /** The version this content was restored from, when it was. */
  @Prop({ type: Number, required: false })
  restoredFromVersion?: number;

  /** The issued version this working revision was opened beside. */
  @Prop({ type: Number, required: false })
  revisedFromVersion?: number;

  /**
   * Who caused it: `USER` or `SYSTEM`.
   *
   * Deliberately not a name. Projects here are anonymous by design — there is no
   * account to attribute to — so recording anything more specific would either be
   * empty or invented.
   */
  @Prop({ type: String, required: false })
  actor?: string;

  createdAt!: Date;
}

export type DocumentVersionDocument = HydratedDocument<DocumentVersionRecord>;
export const DocumentVersionSchema = SchemaFactory.createForClass(DocumentVersionRecord);
DocumentVersionSchema.index({ projectId: 1, type: 1, version: -1 }, { unique: true });

/* ------------------------------------------------------------------- runs */

@Schema({
  collection: 'document_generation_runs',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class DocumentRunRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_RUN_KINDS })
  kind!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_RUN_STATUSES, index: true })
  status!: string;

  @Prop({ type: Number, required: false })
  baselineVersion?: number;

  @Prop({ type: Number, required: false })
  stackVersion?: number;

  @Prop({ type: Number, required: false })
  estimateVersion?: number;

  @Prop({ type: String, required: false, default: '' })
  provider!: string;

  /**
   * Named `modelName`, not `model`.
   *
   * Mongoose's `Document` already has a `model()` method, and a `model` property
   * shadows it — which breaks in ways that surface far from here. Phase 5 found
   * this the hard way; the wire contract still calls the field `model`, and the
   * mapper translates.
   */
  @Prop({ type: String, required: false, default: '' })
  modelName!: string;

  @Prop({ type: Object, required: true, default: {} })
  promptVersions!: Record<string, string>;

  /** Which sections the run wrote. Keys, never content. */
  @Prop({ type: [String], required: true, default: [] })
  sectionKeys!: string[];

  @Prop({ type: Number, required: true, default: 0 })
  inputCharacters!: number;

  @Prop({ type: Number, required: true, default: 0 })
  outputCharacters!: number;

  @Prop({ type: Number, required: true, default: 0 })
  retries!: number;

  @Prop({ type: Date, required: true })
  startedAt!: Date;

  @Prop({ type: Date, required: false })
  completedAt?: Date;

  @Prop({ type: String, required: false, default: '' })
  failureCode!: string;

  @Prop({ type: Boolean, required: true, default: false })
  deterministicOnly!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DocumentRunDocument = HydratedDocument<DocumentRunRecord>;
export const DocumentRunSchema = SchemaFactory.createForClass(DocumentRunRecord);
DocumentRunSchema.index({ projectId: 1, type: 1, startedAt: -1 });

/* ------------------------------------------------------------ corrections */

/**
 * What a reviewer asked to be changed, and what came of it.
 *
 * The instruction text lives here because it is the user's own request and the
 * version history is unreadable without it — "why does version 4 differ from
 * version 3?" is answered by this row. It is project content, held under the same
 * session authority as a requirement, and it never reaches an audit record or a
 * log: `correctionAuditMetadata` carries a length and an outcome instead.
 */
@Schema({
  collection: 'document_corrections',
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  id: false,
  versionKey: false,
})
export class DocumentCorrectionRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  correctionId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  @Prop({ type: String, required: true, enum: CORRECTION_TARGET_KINDS })
  targetKind!: string;

  @Prop({ type: String, required: false, default: '' })
  targetKey!: string;

  @Prop({ type: String, required: true })
  instruction!: string;

  @Prop({ type: String, required: true, default: 'USER' })
  actor!: string;

  @Prop({ type: Number, required: true })
  documentVersion!: number;

  @Prop({ type: Number, required: false })
  resultingVersion?: number;

  @Prop({ type: String, required: false, default: '' })
  runId!: string;

  @Prop({ type: String, required: true, enum: CORRECTION_OUTCOMES })
  outcome!: string;

  @Prop({ type: Boolean, required: true, default: false })
  producedProposal!: boolean;

  @Prop({ type: Boolean, required: true, default: false })
  usedAi!: boolean;

  createdAt!: Date;
}

export type DocumentCorrectionDocument = HydratedDocument<DocumentCorrectionRecord>;
export const DocumentCorrectionSchema = SchemaFactory.createForClass(DocumentCorrectionRecord);
DocumentCorrectionSchema.index({ projectId: 1, type: 1, createdAt: -1 });

/* ---------------------------------------------------- validation results */

/**
 * Validation results, kept rather than overwritten.
 *
 * "It passed when we approved it, and it fails now" is a question somebody asks
 * after a client conversation, and it needs an answer. The document holds the
 * current result for the approval check; this collection is the history.
 */
@Schema({
  collection: 'document_validation_results',
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  id: false,
  versionKey: false,
})
export class DocumentValidationRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  validationId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  @Prop({ type: Number, required: true })
  documentVersion!: number;

  @Prop({ type: String, required: true, enum: VALIDATION_SEVERITIES })
  severity!: string;

  @Prop({ type: [Object], required: true, default: [] })
  findings!: Record<string, unknown>[];

  @Prop({ type: Boolean, required: true, default: false })
  modelAssisted!: boolean;

  createdAt!: Date;
}

export type DocumentValidationDocument = HydratedDocument<DocumentValidationRecord>;
export const DocumentValidationSchema = SchemaFactory.createForClass(DocumentValidationRecord);
DocumentValidationSchema.index({ projectId: 1, type: 1, createdAt: -1 });

/* --------------------------------------------------------------- rows */

/**
 * A structured row of a list document — an acceptance criterion, an assumption.
 *
 * One collection for every row kind, because the engine's operations on a row are
 * the same whatever it contains: order it, protect it when a person edits it, hold
 * a proposal beside it, cite its evidence, exclude it with a reason. `payload`
 * carries the document-specific fields and is parsed by that document's Zod schema
 * before it is written, so nothing unvalidated reaches storage even though Mongoose
 * sees an object.
 *
 * Feature rows keep their own collection: they carry authoritative hours that are
 * reconciled against the approved estimate on every read, and folding them in here
 * would put a number that matters inside an opaque payload.
 */
/*
 * `minimize: false` because a row payload is opaque content, not a Mongoose model.
 *
 * Mongoose strips empty objects by default, so a work package with `effort: {}` — a
 * hand-added task with no hours on it yet — came back with the field missing, and every
 * read of that document then threw. What was written has to be what is read back;
 * deciding an empty object is not worth storing is a judgement for the document's own
 * schema, which has already made it.
 */
@Schema({ collection: 'document_rows', timestamps: true, minimize: false })
export class DocumentRowRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  rowId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES, index: true })
  type!: string;

  @Prop({ type: String, required: true, enum: DOCUMENT_ROW_KINDS })
  kind!: string;

  @Prop({ type: Number, required: true, index: true })
  documentVersion!: number;

  @Prop({ type: Number, required: true, default: 0 })
  order!: number;

  @Prop({ type: String, required: true, enum: ROW_ORIGINS })
  origin!: string;

  /** Why a person added this row, when nothing upstream produced it. */
  @Prop({ type: String, required: false, default: '' })
  attribution!: string;

  /** A suggested rewrite waiting for a decision. Never applied on its own. */
  @Prop({ type: Object, required: false, default: null })
  proposed!: Record<string, unknown> | null;

  @Prop({ type: Date, required: false })
  proposedAt?: Date;

  @Prop({ type: [Object], required: true, default: [] })
  references!: Record<string, unknown>[];

  @Prop({ type: String, required: false, default: '' })
  excludedReason!: string;

  /** The document-specific content. Validated by contract before it gets here. */
  @Prop({ type: Object, required: true, default: {} })
  payload!: Record<string, unknown>;

  createdAt!: Date;
  updatedAt!: Date;
}

export type DocumentRowDocument = HydratedDocument<DocumentRowRecord>;
export const DocumentRowSchema = SchemaFactory.createForClass(DocumentRowRecord);
DocumentRowSchema.index({ projectId: 1, type: 1, documentVersion: 1, order: 1 });
