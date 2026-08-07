import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  AMBIGUITY_KINDS,
  ANALYSIS_FAILURE_REASONS,
  ANALYSIS_RUN_STATUSES,
  BASELINE_STATUSES,
  BLOCK_DISPOSITIONS,
  CLARIFICATION_CATEGORIES,
  CLARIFICATION_IMPACTS,
  CLARIFICATION_STATUSES,
  CONFLICT_KINDS,
  CONFLICT_SEVERITIES,
  CONFLICT_STATUSES,
  DUPLICATE_KINDS,
  FINDING_STATUSES,
  MISSING_DIMENSIONS,
  OUTDATED_REASONS,
  REQUIREMENT_CATEGORIES,
  REQUIREMENT_CHANGE_SOURCES,
  REQUIREMENT_ORIGINS,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
} from '@wdrg/contracts';
import { HydratedDocument } from 'mongoose';

/**
 * Phase 4's collections.
 *
 * Six of them, one per thing with an independent lifecycle. The shape follows
 * from three facts about how this data is used.
 *
 * **Requirements are queried far more often than runs.** A reviewer loads a
 * project's requirements repeatedly while working through them, and loads the
 * run record once. Embedding items in the run would make every list load every
 * task execution the run performed.
 *
 * **Findings are decided one at a time.** A conflict resolution is a write to
 * one small document, not a rewrite of an array inside a larger one. Separate
 * documents also mean optimistic concurrency is per-finding, so two reviewers
 * working through a list do not collide.
 *
 * **A baseline is immutable once approved.** It stores the item *ids* it
 * contains rather than the items, because a later edit must not change what an
 * approved baseline says — and it stores the coverage and alignment numbers
 * calculated at approval, for the same reason.
 *
 * Every collection is indexed on `projectId` first, because every query in this
 * phase is scoped to one project by a verified session and there is no query
 * shape that legitimately crosses projects.
 */

export const ANALYSIS_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ run */

@Schema({
  collection: 'analysis_runs',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class AnalysisRunRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  sequence!: number;

  @Prop({ type: String, required: true, enum: ANALYSIS_RUN_STATUSES, index: true })
  status!: string;

  @Prop({ type: [String], required: true, default: [] })
  sourceIds!: string[];

  /**
   * A digest of the reviewed content this run read.
   *
   * The mechanism behind outdated-state propagation: comparing the project's
   * current digest against this one answers "have the sources moved on?"
   * without re-reading a single document.
   */
  @Prop({ type: String, required: true })
  contentDigest!: string;

  @Prop({ type: Object, required: true })
  progress!: Record<string, unknown>;

  /**
   * Every AI task execution.
   *
   * Embedded despite being an array, because it is only ever read with the run
   * and never queried across runs — and because "what did the model actually
   * do" has to survive as one atomic record beside the run it belongs to.
   */
  @Prop({ type: [Object], required: true, default: [] })
  executions!: Record<string, unknown>[];

  @Prop({ type: String, required: true })
  modelProfileId!: string;

  /**
   * Named `modelName` rather than `model`.
   *
   * Mongoose's `Document` already has a `model()` method, and a property that
   * shadows it produces a field whose value depends on whether you are holding
   * a hydrated document or a plain object. The contract still calls it `model`;
   * the mapper translates.
   */
  @Prop({ type: String, required: true })
  modelName!: string;

  @Prop({ type: String, required: true })
  provider!: string;

  @Prop({ type: String, required: true })
  promptRegistryChecksum!: string;

  @Prop({ type: String, enum: ANALYSIS_FAILURE_REASONS })
  failureReason?: string;

  @Prop({ type: String })
  baselineId?: string;

  @Prop({ type: Date, required: true })
  startedAt!: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  /** Set by a cancel request. The pipeline checks it between every task. */
  @Prop({ type: Date })
  cancellationRequestedAt?: Date;

  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number, required: true, default: ANALYSIS_SCHEMA_VERSION })
  schemaVersion!: number;
}

export type AnalysisRunDocument = HydratedDocument<AnalysisRunRecord>;
export const AnalysisRunSchema = SchemaFactory.createForClass(AnalysisRunRecord);

AnalysisRunSchema.index({ projectId: 1, sequence: -1 });
AnalysisRunSchema.index({ projectId: 1, status: 1 });

/* ------------------------------------------------------------ chunks */

@Schema({ collection: 'analysis_chunks', timestamps: true, id: false, versionKey: false })
export class AnalysisChunkRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  chunkId!: string;

  @Prop({ type: String, required: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  index!: number;

  @Prop({ type: String, required: true })
  sourceId!: string;

  @Prop({ type: String, required: true })
  sourceName!: string;

  @Prop({ type: [String], required: true, default: [] })
  blockIds!: string[];

  @Prop({ type: [Object], required: true, default: [] })
  blockParts!: { blockId: string; parts: number }[];

  @Prop({ type: Number, required: true })
  characterCount!: number;

  @Prop({ type: Number, required: true })
  estimatedTokens!: number;

  @Prop({ type: String, required: true })
  boundary!: string;

  @Prop({ type: String })
  heading?: string;

  @Prop({ type: String, required: true, default: 'pending' })
  status!: string;

  @Prop({ type: String })
  failureReason?: string;
}

export type AnalysisChunkDocument = HydratedDocument<AnalysisChunkRecord>;
export const AnalysisChunkSchema = SchemaFactory.createForClass(AnalysisChunkRecord);

AnalysisChunkSchema.index({ runId: 1, index: 1 });

/* ------------------------------------------------------- requirements */

@Schema({
  collection: 'requirement_items',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class RequirementItemRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  itemId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true })
  key!: string;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, required: true })
  statement!: string;

  @Prop({ type: String, required: true, enum: REQUIREMENT_CATEGORIES, index: true })
  category!: string;

  @Prop({ type: String })
  nfrDimension?: string;

  @Prop({ type: String, required: true, enum: REQUIREMENT_PRIORITIES })
  priority!: string;

  @Prop({ type: [Object], required: true, default: [] })
  references!: Record<string, unknown>[];

  /** The model's opinion of its own output. Stored, shown, never acted on. */
  @Prop({ type: Object })
  modelConfidence?: Record<string, unknown>;

  /** Calculated by application code. This is the one that governs. */
  @Prop({ type: Object, required: true })
  evidenceConfidence!: Record<string, unknown>;

  @Prop({ type: String, required: true, enum: REQUIREMENT_ORIGINS })
  origin!: string;

  @Prop({ type: String, required: true, enum: REQUIREMENT_STATUSES, index: true })
  status!: string;

  /**
   * Set the first time a person changes this, and never cleared.
   *
   * Read by re-analysis, which refuses to overwrite an item carrying it.
   */
  @Prop({ type: Boolean, required: true, default: false })
  editedByUser!: boolean;

  @Prop({ type: [String], required: true, default: [] })
  chunkIds!: string[];

  @Prop({ type: String })
  supersededById?: string;

  /**
   * A revision waiting for a person.
   *
   * Present only where a clarification's answer touched a requirement that must
   * not be rewritten automatically — one somebody edited, wrote, or approved.
   */
  @Prop({ type: Object })
  proposedRevision?: Record<string, unknown>;

  /** Something changed that this requirement has not been checked against yet. */
  @Prop({ type: Boolean, required: true, default: false })
  needsRevalidation!: boolean;

  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number, required: true, default: ANALYSIS_SCHEMA_VERSION })
  schemaVersion!: number;
}

export type RequirementItemDocument = HydratedDocument<RequirementItemRecord>;
export const RequirementItemSchema = SchemaFactory.createForClass(RequirementItemRecord);

RequirementItemSchema.index({ projectId: 1, runId: 1, key: 1 });
RequirementItemSchema.index({ projectId: 1, status: 1 });

/* ----------------------------------------------------------- findings */

/**
 * One collection for four kinds of finding.
 *
 * They differ in their payload and agree in everything that is queried: which
 * project, which run, what status, what a person decided. Four collections
 * would mean four near-identical repositories and four queries to render one
 * screen, for a distinction that only exists inside the `payload`.
 */
@Schema({
  collection: 'analysis_findings',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class AnalysisFindingRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  findingId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, index: true })
  runId!: string;

  @Prop({
    type: String,
    required: true,
    enum: ['duplicate', 'conflict', 'ambiguity', 'missing'],
    index: true,
  })
  type!: 'duplicate' | 'conflict' | 'ambiguity' | 'missing';

  /**
   * Wider than `FINDING_STATUSES` because a conflict can be settled by a
   * clarification, which the other finding kinds cannot.
   */
  @Prop({
    type: String,
    required: true,
    enum: [...new Set([...FINDING_STATUSES, ...CONFLICT_STATUSES])],
    index: true,
  })
  status!: string;

  /** Ids of the requirements this finding is about. Queried, so it is top-level. */
  @Prop({ type: [String], required: true, default: [] })
  itemIds!: string[];

  /** `blocking` for a conflict, or the `blocksImplementation` flag for a gap. */
  @Prop({ type: Boolean, required: true, default: false })
  blocking!: boolean;

  @Prop({
    type: String,
    enum: [...DUPLICATE_KINDS, ...CONFLICT_KINDS, ...AMBIGUITY_KINDS, ...MISSING_DIMENSIONS],
  })
  kind?: string;

  @Prop({ type: String, enum: CONFLICT_SEVERITIES })
  severity?: string;

  /** The kind-specific fields. Read whole; never queried into. */
  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: Object })
  resolution?: Record<string, unknown>;

  /**
   * Every re-evaluation this conflict has been through, oldest first.
   *
   * Append-only, and embedded because it is only read with the conflict.
   * Conflicts only; the other finding kinds never carry any.
   */
  @Prop({ type: [Object], required: true, default: [] })
  reevaluations!: Record<string, unknown>[];

  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number, required: true, default: ANALYSIS_SCHEMA_VERSION })
  schemaVersion!: number;
}

export type AnalysisFindingDocument = HydratedDocument<AnalysisFindingRecord>;
export const AnalysisFindingSchema = SchemaFactory.createForClass(AnalysisFindingRecord);

AnalysisFindingSchema.index({ projectId: 1, type: 1, status: 1 });

/* ------------------------------------------------------ clarifications */

@Schema({
  collection: 'clarifications',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class ClarificationRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  clarificationId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true })
  key!: string;

  @Prop({ type: String, required: true })
  question!: string;

  @Prop({ type: String, required: true })
  rationale!: string;

  @Prop({ type: String, required: true, enum: CLARIFICATION_CATEGORIES })
  category!: string;

  @Prop({ type: String, required: true, enum: CLARIFICATION_IMPACTS })
  impact!: string;

  @Prop({ type: String })
  dimension?: string;

  @Prop({ type: [String], required: true, default: [] })
  relatedItemIds!: string[];

  @Prop({ type: [String], required: true, default: [] })
  relatedConflictIds!: string[];

  @Prop({ type: [String], required: true, default: [] })
  relatedFindingIds!: string[];

  @Prop({ type: String, required: true, enum: CLARIFICATION_STATUSES, index: true })
  status!: string;

  /**
   * Every answer version, oldest first. Never pruned.
   *
   * Embedded rather than a collection: they are only ever read with the
   * clarification, there are a handful at most, and a requirement traced to
   * "confirmed clarification Q-004" has to be readable against the answer that
   * was current when it was written.
   */
  @Prop({ type: [Object], required: true, default: [] })
  answers!: Record<string, unknown>[];

  /** Present only when dismissed: the disposition, its reference and its check. */
  @Prop({ type: Object })
  dismissal?: Record<string, unknown>;

  @Prop({ type: Boolean, required: true, default: false })
  blocksApproval!: boolean;

  @Prop({ type: Number, required: true, default: 0 })
  version!: number;

  @Prop({ type: Number, required: true, default: ANALYSIS_SCHEMA_VERSION })
  schemaVersion!: number;
}

export type ClarificationDocument = HydratedDocument<ClarificationRecord>;
export const ClarificationSchema = SchemaFactory.createForClass(ClarificationRecord);

ClarificationSchema.index({ projectId: 1, status: 1 });

/* ----------------------------------------------------------- baseline */

@Schema({
  collection: 'requirement_baselines',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class BaselineRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  baselineId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: String, required: true })
  runId!: string;

  /** 1-based, per project. The number a person sees: "Baseline v2". */
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, required: true, enum: BASELINE_STATUSES, index: true })
  status!: string;

  /**
   * The item ids, not the items.
   *
   * An approved baseline must keep saying what it said. Storing ids means a
   * later edit to a requirement cannot retroactively change what was signed —
   * the baseline names which requirements, and the requirement records carry
   * their own version history.
   */
  @Prop({ type: [String], required: true, default: [] })
  itemIds!: string[];

  @Prop({ type: Number, required: true, default: 0 })
  itemCount!: number;

  @Prop({ type: Object, required: true, default: {} })
  categoryCounts!: Record<string, number>;

  @Prop({ type: Object, required: true })
  coverage!: Record<string, unknown>;

  @Prop({ type: Object, required: true })
  alignment!: Record<string, unknown>;

  @Prop({ type: [Object], required: true, default: [] })
  blockers!: Record<string, unknown>[];

  @Prop({ type: [Object], required: true, default: [] })
  dispositions!: Record<string, unknown>[];

  @Prop({ type: String, required: true })
  contentDigest!: string;

  @Prop({ type: Date })
  approvedAt?: Date;

  @Prop({ type: String })
  approvalNote?: string;

  @Prop({ type: String, enum: OUTDATED_REASONS })
  outdatedReason?: string;

  @Prop({ type: Date })
  outdatedAt?: Date;

  @Prop({ type: Number })
  supersededByVersion?: number;

  @Prop({ type: Number, required: true, default: 0 })
  recordVersion!: number;

  @Prop({ type: Number, required: true, default: ANALYSIS_SCHEMA_VERSION })
  schemaVersion!: number;
}

export type BaselineDocument = HydratedDocument<BaselineRecord>;
export const BaselineSchema = SchemaFactory.createForClass(BaselineRecord);

BaselineSchema.index({ projectId: 1, version: -1 }, { unique: true });
BaselineSchema.index({ projectId: 1, status: 1 });

/* ------------------------------------------------- requirement history */

/**
 * One historical version of a requirement.
 *
 * Its own collection, unlike the clarification's answers, because a project can
 * accumulate thousands of these and they are read rarely — embedding them would
 * make every requirement list carry the whole history of every requirement.
 */
@Schema({ collection: 'requirement_versions', timestamps: true, id: false, versionKey: false })
export class RequirementVersionRecord {
  @Prop({ type: String, required: true, index: true })
  itemId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, required: true })
  title!: string;

  @Prop({ type: String, required: true })
  statement!: string;

  @Prop({ type: String, required: true })
  category!: string;

  @Prop({ type: String, required: true })
  priority!: string;

  @Prop({ type: String, required: true })
  status!: string;

  @Prop({ type: [Object], required: true, default: [] })
  references!: Record<string, unknown>[];

  @Prop({ type: String, required: true, enum: REQUIREMENT_CHANGE_SOURCES })
  changedBy!: string;

  @Prop({ type: String })
  reason?: string;

  @Prop({ type: String })
  clarificationKey?: string;

  @Prop({ type: Date, required: true })
  recordedAt!: Date;
}

export type RequirementVersionDocument = HydratedDocument<RequirementVersionRecord>;
export const RequirementVersionSchema = SchemaFactory.createForClass(RequirementVersionRecord);

RequirementVersionSchema.index({ projectId: 1, itemId: 1, version: -1 });

/* ---------------------------------------------------- conflict history */

/**
 * An immutable snapshot of a conflict, written before every change to one.
 *
 * Its own collection rather than an embedded array because the positions are
 * copied *in full* — the whole point is to answer "what was conflicting before
 * the clarification?", and a reference to a requirement that has since been
 * rewritten cannot answer it. Embedding whole positions would grow the conflict
 * document on every re-evaluation.
 */
@Schema({ collection: 'conflict_versions', timestamps: true, id: false, versionKey: false })
export class ConflictVersionRecord {
  @Prop({ type: String, required: true, index: true })
  conflictId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, required: true })
  status!: string;

  @Prop({ type: String, required: true })
  severity!: string;

  @Prop({ type: String, required: true })
  kind!: string;

  @Prop({ type: String, required: true, default: '' })
  summary!: string;

  @Prop({ type: [String], required: true, default: [] })
  itemIds!: string[];

  /** Copied whole. A rewritten requirement must not change this record. */
  @Prop({ type: [Object], required: true, default: [] })
  positions!: Record<string, unknown>[];

  @Prop({
    type: String,
    required: true,
    enum: ['analysis', 'user_decision', 'clarification_reevaluation'],
  })
  changedBy!: string;

  @Prop({ type: String })
  clarificationKey?: string;

  @Prop({ type: String })
  rationale?: string;

  @Prop({ type: Date, required: true })
  recordedAt!: Date;
}

export type ConflictVersionDocument = HydratedDocument<ConflictVersionRecord>;
export const ConflictVersionSchema = SchemaFactory.createForClass(ConflictVersionRecord);

ConflictVersionSchema.index({ projectId: 1, conflictId: 1, version: -1 });

/** Every block disposition, so coverage can be recomputed and audited. */
export const BLOCK_DISPOSITION_VALUES = BLOCK_DISPOSITIONS;
