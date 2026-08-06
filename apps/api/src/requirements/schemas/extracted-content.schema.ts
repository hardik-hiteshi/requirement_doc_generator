import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ExtractedContentDocument = HydratedDocument<ExtractedContentRecord>;

export const EXTRACTED_CONTENT_SCHEMA_VERSION = 1;

/**
 * One immutable revision of a source's extracted content.
 *
 * Revision 0 is what the extractor produced. Every later revision is a
 * correction. **Nothing here is ever updated in place** — a correction inserts a
 * new document, which is what makes "restore the original" a read rather than an
 * undo, and what makes the revision history a genuine record rather than a
 * changelog someone has to trust.
 *
 * `blocks` is stored as a free-form array and validated by the Zod contract at
 * the boundary, for the same reason the project's structured sections are:
 * mirroring the discriminated shapes in a Mongoose schema would restate every
 * rule in a second language and let the two drift.
 */
@Schema({
  collection: 'extracted_content',
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  id: false,
  versionKey: false,
})
export class ExtractedContentRecord {
  @Prop({ type: String, required: true, index: true })
  sourceId!: string;

  /** Denormalised so a project delete does not have to join to find these. */
  @Prop({ type: String, required: true, index: true })
  projectId!: string;

  @Prop({ type: Number, required: true })
  revision!: number;

  @Prop({ type: String, required: true, enum: ['EXTRACTION', 'CORRECTION', 'RESTORE'] })
  origin!: 'EXTRACTION' | 'CORRECTION' | 'RESTORE';

  @Prop({ type: [Object], required: true, default: [] })
  blocks!: Record<string, unknown>[];

  @Prop({ type: [Object], required: true, default: [] })
  warnings!: Record<string, unknown>[];

  @Prop({ type: Number, required: true, default: 1 })
  minimumConfidence!: number;

  @Prop({ type: Number })
  pageCount?: number;

  @Prop({ type: [String], default: undefined })
  sheetNames?: string[];

  @Prop({ type: Boolean, required: true, default: false })
  usedOcr!: boolean;

  @Prop({ type: String, required: true })
  extractor!: string;

  /** Block ids the user changed in this revision. Empty for revision 0. */
  @Prop({ type: [String], required: true, default: [] })
  changedBlockIds!: string[];

  @Prop({ type: String })
  note?: string;

  @Prop({ type: Number, required: true, default: EXTRACTED_CONTENT_SCHEMA_VERSION })
  schemaVersion!: number;

  createdAt!: Date;
}

export const ExtractedContentSchema = SchemaFactory.createForClass(ExtractedContentRecord);

/*
 * `(sourceId, revision)` is unique: two documents claiming to be revision 3 of
 * the same source would make "the current content" ambiguous, and the ambiguity
 * would only surface as a user seeing someone else's correction.
 */
ExtractedContentSchema.index(
  { sourceId: 1, revision: -1 },
  { name: 'source_revisions', unique: true },
);

/* Deleting a project removes its content without touching the source records. */
ExtractedContentSchema.index({ projectId: 1 }, { name: 'project_content' });
