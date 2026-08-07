import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  RECOMMENDATION_RUN_STATUSES,
  STACK_COMPONENT_STATUSES,
  STACK_OUTDATED_REASONS,
  STACK_SELECTION_MODES,
  STACK_SNAPSHOT_STATUSES,
  TECHNOLOGY_CATEGORIES,
} from '@wdrg/contracts';
import { HydratedDocument } from 'mongoose';

/**
 * Phase 5's collections.
 *
 * Three, and the split follows the same reasoning Phase 4 used.
 *
 * **A component is decided one at a time.** Accepting a suggestion is a write
 * to one small document, not a rewrite of an array inside a larger one — and
 * optimistic concurrency is therefore per-component, so a user working down the
 * list does not collide with themselves in a second tab.
 *
 * **A snapshot is immutable once locked.** It stores the component ids it
 * contains rather than the components, and the findings and blockers as they
 * stood at the time. A later edit must not change what a locked stack says,
 * because Phase 6 prices exactly that.
 *
 * **A recommendation run is a record, not a result.** It holds sizes, timings
 * and failures; never the requirements it read, which are the client's
 * confidential material and would otherwise land in an operator's log.
 *
 * Every collection is indexed on `projectId` first. Every query in this phase is
 * scoped to one project by a verified session, and there is no query shape that
 * legitimately crosses projects.
 */

export const STACK_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------ snapshot */

@Schema({
  collection: 'stack_snapshots',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class StackSnapshotRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  snapshotId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  /** 1-based, per project. The user-facing "Stack v2". */
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, required: true, enum: STACK_SNAPSHOT_STATUSES, index: true })
  status!: string;

  @Prop({ type: String, required: true, enum: STACK_SELECTION_MODES })
  selectionMode!: string;

  @Prop({ type: String, required: false })
  baselineId?: string;

  @Prop({ type: Number, required: false })
  baselineVersion?: number;

  /**
   * The project types as they stood when this snapshot was made.
   *
   * Stored rather than read live, so a later change is *detectable*. Comparing
   * these against the project's current types is what marks a stack out of
   * date — a live read would silently agree with itself forever.
   */
  @Prop({ type: [String], required: true, default: [] })
  projectTypes!: string[];

  @Prop({ type: [Object], required: true, default: [] })
  categoryPlan!: Record<string, unknown>[];

  /** Component ids. The components themselves live in their own collection. */
  @Prop({ type: [String], required: true, default: [] })
  componentIds!: string[];

  @Prop({ type: [Object], required: true, default: [] })
  compatibilityFindings!: Record<string, unknown>[];

  @Prop({ type: String, default: 'NONE' })
  highestRisk!: string;

  @Prop({ type: [Object], required: true, default: [] })
  blockers!: Record<string, unknown>[];

  /** Append-only. Every act a person took, in order. */
  @Prop({ type: [Object], required: true, default: [] })
  decisions!: Record<string, unknown>[];

  @Prop({ type: String, required: false })
  lastRecommendationRunId?: string;

  @Prop({ type: Date, required: false })
  approvedAt?: Date;

  @Prop({ type: String, required: false })
  approvalNote?: string;

  @Prop({ type: Date, required: false })
  lockedAt?: Date;

  @Prop({ type: Date, required: false })
  outdatedAt?: Date;

  @Prop({ type: String, required: false, enum: STACK_OUTDATED_REASONS })
  outdatedReason?: string;

  @Prop({ type: Number, required: false })
  supersededByVersion?: number;

  /**
   * Optimistic concurrency for the row.
   *
   * Named apart from `version`, which is the stack's own user-facing number.
   * Conflating a document version with a row revision is how one silently
   * becomes the other.
   */
  @Prop({ type: Number, required: true, default: 0 })
  recordVersion!: number;

  @Prop({ type: Number, required: true, default: STACK_SCHEMA_VERSION })
  schemaVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type StackSnapshotDocument = HydratedDocument<StackSnapshotRecord>;
export const StackSnapshotSchema = SchemaFactory.createForClass(StackSnapshotRecord);

StackSnapshotSchema.index({ projectId: 1, version: -1 });
StackSnapshotSchema.index({ projectId: 1, status: 1 });

/* ----------------------------------------------------------- component */

@Schema({
  collection: 'stack_components',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class StackComponentRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  componentId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  /** The snapshot version this component belongs to. */
  @Prop({ type: Number, required: true, index: true })
  stackVersion!: number;

  @Prop({ type: String, required: true, enum: TECHNOLOGY_CATEGORIES, index: true })
  category!: string;

  /**
   * The catalogue id, absent for a technology the user typed.
   *
   * Its absence is the only thing that makes a component custom, and it is what
   * tells every reader to show "no reviewed facts held" rather than blanks that
   * would read like facts.
   */
  @Prop({ type: String, required: false })
  technologyId?: string;

  @Prop({ type: String, required: true })
  technologyName!: string;

  @Prop({ type: String, required: true, enum: STACK_COMPONENT_STATUSES, index: true })
  status!: string;

  @Prop({ type: String, required: true })
  authority!: string;

  @Prop({ type: String, required: false })
  selectionSource?: string;

  @Prop({ type: Boolean, required: true, default: false })
  mandatory!: boolean;

  @Prop({ type: Object, required: true })
  version!: Record<string, unknown>;

  @Prop({ type: Object, required: true })
  evidence!: Record<string, unknown>;

  /** Application-computed. Never assigned by a model. */
  @Prop({ type: Number, required: true, default: 0 })
  evidenceStrength!: number;

  @Prop({ type: [Object], required: true, default: [] })
  evidenceContributions!: Record<string, unknown>[];

  /* Facts copied from the catalogue at the time of the decision. */
  /*
   * Not `required`, deliberately. Mongoose treats an empty string as absent, so
   * a required field with an empty default rejects every custom technology —
   * which is exactly the case that must work.
   */
  @Prop({ type: String, default: '' })
  licence!: string;

  @Prop({ type: String, default: 'UNKNOWN' })
  costPosture!: string;

  @Prop({ type: Boolean, required: true, default: false })
  selfHostable!: boolean;

  /** Model prose and its self-assessment, kept apart from everything above. */
  @Prop({ type: Object, required: false })
  recommendation?: Record<string, unknown>;

  @Prop({ type: [Object], required: true, default: [] })
  riskAcknowledgements!: Record<string, unknown>[];

  @Prop({ type: String, default: '' })
  notes!: string;

  @Prop({ type: String, required: false })
  replacedTechnologyName?: string;

  @Prop({ type: String, required: false })
  replacedReason?: string;

  @Prop({ type: Date, required: false })
  lockedAt?: Date;

  @Prop({ type: Number, required: true, default: 0 })
  recordVersion!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type StackComponentDocument = HydratedDocument<StackComponentRecord>;
export const StackComponentSchema = SchemaFactory.createForClass(StackComponentRecord);

StackComponentSchema.index({ projectId: 1, stackVersion: 1, category: 1 });

/* ---------------------------------------------------- recommendation run */

@Schema({
  collection: 'stack_recommendation_runs',
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  id: false,
  versionKey: false,
})
export class RecommendationRunRecord {
  @Prop({ type: String, required: true, unique: true, index: true })
  runId!: string;

  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  stackVersion!: number;

  @Prop({ type: Number, required: true })
  baselineVersion!: number;

  @Prop({ type: [String], required: true, default: [] })
  projectTypes!: string[];

  @Prop({ type: [String], required: true, default: [] })
  categoriesRequested!: string[];

  @Prop({ type: [String], required: true, default: [] })
  categoriesFilled!: string[];

  @Prop({ type: String, required: true })
  provider!: string;

  /**
   * Named `modelName`, not `model`.
   *
   * Mongoose's `Document` already has a `model()` method, and a `model`
   * property shadows it — the document then looks fine and breaks the moment
   * anything calls it. Phase 4 hit this and named its field the same way.
   */
  @Prop({ type: String, required: true })
  modelName!: string;

  @Prop({ type: String, required: true })
  promptVersion!: string;

  /**
   * Characters in, characters out.
   *
   * Never the text itself. A run record is read by an operator debugging a
   * deployment, and the requirements it read are the client's confidential
   * material.
   */
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

  @Prop({ type: Date, required: false })
  completedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type RecommendationRunDocument = HydratedDocument<RecommendationRunRecord>;
export const RecommendationRunSchema = SchemaFactory.createForClass(RecommendationRunRecord);

RecommendationRunSchema.index({ projectId: 1, createdAt: -1 });
