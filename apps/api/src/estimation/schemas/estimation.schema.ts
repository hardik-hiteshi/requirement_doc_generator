import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  DEPENDENCY_TYPES,
  ESTIMATE_STATUSES,
  ESTIMATE_OUTDATED_REASONS,
  ESTIMATE_SOURCES,
  RECOMMENDATION_RUN_STATUSES,
} from '@wdrg/contracts';
import { HydratedDocument } from 'mongoose';

/**
 * Phase 6's collections.
 *
 * Four, split on the same reasoning as Phases 4 and 5.
 *
 * **An estimate unit is edited one at a time.** Overriding a figure is a write
 * to one small document, and optimistic concurrency is per-unit — a user
 * working down a table of forty features does not collide with themselves.
 *
 * **A dependency is its own document.** The graph is edited link by link, and a
 * link is the thing a person adds and removes.
 *
 * **A snapshot is immutable once approved.** It stores the ids it contains and
 * the totals, schedule and feasibility *as they stood* — an approved estimate
 * must keep saying what it said when it was signed, whatever changes later.
 *
 * **A run is a record, not a result.** Sizes, timings and failures; never the
 * requirement text it read.
 *
 * Every collection is indexed on `projectId` first. Every query in this phase is
 * scoped to one project by a verified session.
 */

export const ESTIMATION_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------- snapshot */

@Schema({
  collection: 'estimate_snapshots',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class EstimateSnapshotRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  snapshotId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, required: true, enum: ESTIMATE_STATUSES, index: true })
  status!: string;

  /* What it was calculated against, stored so a later change is detectable. */
  @Prop({ type: String, required: false })
  baselineId?: string;

  @Prop({ type: Number, required: false })
  baselineVersion?: number;

  @Prop({ type: String, required: false })
  stackSnapshotId?: string;

  @Prop({ type: Number, required: false })
  stackVersion?: number;

  /**
   * A digest of the timeline.
   *
   * Cheaper and less brittle than storing the discriminated union and
   * comparing field by field — one string comparison answers "has the deadline
   * moved?", which is what the outdated check needs.
   */
  @Prop({ type: String, required: false })
  timelineDigest?: string;

  @Prop({ type: String, required: true, default: '' })
  timelineDescription!: string;

  @Prop({ type: String, required: true, default: 'NOT_CONFIRMED' })
  startDateMode!: string;

  @Prop({ type: String, required: false })
  startDate?: string;

  @Prop({ type: Object, required: true })
  calendar!: Record<string, unknown>;

  @Prop({ type: Object, required: true })
  team!: Record<string, unknown>;

  @Prop({ type: [Object], required: true, default: [] })
  customRoles!: Record<string, unknown>[];

  @Prop({ type: Object, required: true })
  existingSystem!: Record<string, unknown>;

  @Prop({ type: [Object], required: true, default: [] })
  integrations!: Record<string, unknown>[];

  @Prop({ type: String, required: true })
  productivityModelVersion!: string;

  /**
   * Whether client-facing documents may mention AI assistance.
   *
   * Defaults to false. A proposal that volunteers how the code was written
   * starts a conversation about price that is the user's to start.
   */
  @Prop({ type: Boolean, required: true, default: false })
  mentionAiAssistance!: boolean;

  @Prop({ type: [Object], required: true, default: [] })
  milestones!: Record<string, unknown>[];

  /* Computed values, stored because the approval endpoint reads them. */
  @Prop({ type: Object, required: true })
  totalEffort!: Record<string, unknown>;

  @Prop({ type: Object, required: true })
  effortByRole!: Record<string, unknown>;

  @Prop({ type: Number, required: true, default: 0 })
  implementationHours!: number;

  @Prop({ type: Number, required: true, default: 0 })
  overheadHours!: number;

  @Prop({ type: Object, required: true })
  schedule!: Record<string, unknown>;

  @Prop({ type: [Object], required: true, default: [] })
  utilisation!: Record<string, unknown>[];

  @Prop({ type: [Object], required: true, default: [] })
  recommendedStaffing!: Record<string, unknown>[];

  @Prop({ type: Object, required: true })
  feasibility!: Record<string, unknown>;

  @Prop({ type: [Object], required: true, default: [] })
  blockers!: Record<string, unknown>[];

  @Prop({ type: Date, required: false })
  riskAcknowledgedAt?: Date;

  @Prop({ type: String, required: false })
  riskAcknowledgementNote?: string;

  /**
   * Which feasibility status was acknowledged.
   *
   * Not a boolean. A user who accepted "tight" has not accepted "not possible
   * with this team" — so if the plan degrades, the acknowledgement stops
   * covering it and the blocker returns.
   */
  @Prop({ type: String, required: false })
  riskAcknowledgedStatus?: string;

  @Prop({ type: Date, required: false })
  approvedAt?: Date;

  @Prop({ type: String, required: false })
  approvalNote?: string;

  @Prop({ type: Date, required: false })
  outdatedAt?: Date;

  @Prop({ type: String, required: false, enum: ESTIMATE_OUTDATED_REASONS })
  outdatedReason?: string;

  @Prop({ type: Number, required: false })
  supersededByVersion?: number;

  @Prop({ type: Number, required: true, default: 0 })
  recordVersion!: number;

  @Prop({ type: Number, required: true, default: ESTIMATION_SCHEMA_VERSION })
  schemaVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type EstimateSnapshotDocument = HydratedDocument<EstimateSnapshotRecord>;
export const EstimateSnapshotSchema = SchemaFactory.createForClass(EstimateSnapshotRecord);

EstimateSnapshotSchema.index({ projectId: 1, version: -1 });
EstimateSnapshotSchema.index({ projectId: 1, status: 1 });

/* --------------------------------------------------------- estimate unit */

@Schema({
  collection: 'estimate_units',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class EstimateUnitRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  unitId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true, index: true })
  estimateVersion!: number;

  @Prop({ type: String, required: true })
  key!: string;

  @Prop({ type: [String], required: true, default: [] })
  requirementIds!: string[];

  @Prop({ type: String, default: '' })
  module!: string;

  @Prop({ type: String, default: '' })
  submodule!: string;

  @Prop({ type: String, required: true })
  feature!: string;

  @Prop({ type: String, required: true })
  taskCategory!: string;

  /** Set on the lines that are overhead rather than a feature. */
  @Prop({ type: String, required: false })
  overheadActivity?: string;

  @Prop({ type: String, required: true })
  complexity!: string;

  @Prop({ type: [String], required: true, default: [] })
  complexityDrivers!: string[];

  @Prop({ type: String, default: '' })
  complexityExplanation!: string;

  @Prop({ type: String, required: true })
  uncertainty!: string;

  @Prop({ type: [String], required: true, default: [] })
  uncertaintySources!: string[];

  @Prop({ type: String, default: '' })
  uncertaintyExplanation!: string;

  /** Hours per role. An absent role means no work of that kind. */
  @Prop({ type: Object, required: true })
  effort!: Record<string, number>;

  @Prop({ type: Number, required: true, default: 0 })
  totalHours!: number;

  @Prop({ type: Object, required: true })
  range!: Record<string, number>;

  @Prop({ type: [Object], required: true, default: [] })
  drivers!: Record<string, unknown>[];

  @Prop({ type: String, default: '' })
  rationale!: string;

  @Prop({ type: String, required: true, enum: ESTIMATE_SOURCES, index: true })
  source!: string;

  /** What it was before a person changed it, so a reset needs no re-run. */
  @Prop({ type: Object, required: false })
  originalEffort?: Record<string, number>;

  @Prop({ type: Number, required: false })
  originalTotalHours?: number;

  @Prop({ type: String, required: false })
  overrideNote?: string;

  @Prop({ type: Boolean, required: true, default: false })
  excluded!: boolean;

  @Prop({ type: String, required: false })
  exclusionReason?: string;

  @Prop({ type: Number, required: true, default: 0 })
  recordVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type EstimateUnitDocument = HydratedDocument<EstimateUnitRecord>;
export const EstimateUnitSchema = SchemaFactory.createForClass(EstimateUnitRecord);

EstimateUnitSchema.index({ projectId: 1, estimateVersion: 1 });

/* ----------------------------------------------------------- dependency */

@Schema({
  collection: 'estimate_dependencies',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class EstimateDependencyRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  dependencyId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true, index: true })
  estimateVersion!: number;

  @Prop({ type: String, required: true })
  predecessorId!: string;

  @Prop({ type: String, required: true })
  successorId!: string;

  @Prop({ type: String, required: true, enum: DEPENDENCY_TYPES })
  type!: string;

  @Prop({ type: String, required: true })
  reason!: string;

  @Prop({ type: Number, required: true, default: 0 })
  lagDays!: number;

  /** True when a person added or kept it, which protects it from re-estimation. */
  @Prop({ type: Boolean, required: true, default: false })
  userDefined!: boolean;

  @Prop({ type: String, required: false })
  note?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export type EstimateDependencyDocument = HydratedDocument<EstimateDependencyRecord>;
export const EstimateDependencySchema = SchemaFactory.createForClass(EstimateDependencyRecord);

EstimateDependencySchema.index({ projectId: 1, estimateVersion: 1 });

/* ------------------------------------------------------------ run record */

@Schema({
  collection: 'estimation_runs',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class EstimationRunRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  estimateVersion!: number;

  @Prop({ type: Number, required: true, default: 0 })
  baselineVersion!: number;

  @Prop({ type: Number, required: true, default: 0 })
  stackVersion!: number;

  @Prop({ type: Number, required: true, default: 0 })
  requirementCount!: number;

  @Prop({ type: Number, required: true, default: 0 })
  unitsProduced!: number;

  @Prop({ type: String, required: true })
  provider!: string;

  /** Named `modelName`: a `model` property shadows Mongoose's `Document.model()`. */
  @Prop({ type: String, required: true })
  modelName!: string;

  @Prop({ type: String, required: true })
  promptVersion!: string;

  @Prop({ type: String, required: true })
  productivityModelVersion!: string;

  /** Characters in, characters out. Never the requirement text itself. */
  @Prop({ type: Number, required: true, default: 0 })
  inputSize!: number;

  @Prop({ type: Number, required: true, default: 0 })
  outputSize!: number;

  @Prop({ type: Number, required: true, default: 0 })
  durationMs!: number;

  @Prop({ type: String, required: true, enum: RECOMMENDATION_RUN_STATUSES, index: true })
  status!: string;

  @Prop({ type: Number, required: true, default: 0 })
  retryCount!: number;

  @Prop({ type: [String], required: true, default: [] })
  failures!: string[];

  @Prop({ type: [Object], required: true, default: [] })
  executions!: Record<string, unknown>[];

  /** Units a person had authored, which the run left alone. Counted, not named. */
  @Prop({ type: Number, required: true, default: 0 })
  preservedOverrides!: number;

  @Prop({ type: Date, required: false })
  completedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type EstimationRunDocument = HydratedDocument<EstimationRunRecord>;
export const EstimationRunSchema = SchemaFactory.createForClass(EstimationRunRecord);

EstimationRunSchema.index({ projectId: 1, createdAt: -1 });
